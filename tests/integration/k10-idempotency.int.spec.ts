/**
 * K-10 — Idempotency.
 *
 * Every case runs against real PostgreSQL as the real application role. The
 * guarantee under test ("the key is claimed inside the work's transaction")
 * lives in the database, so a mock would only prove that the mock works.
 *
 * The cases map to the plan:
 *  T01 missing key · T02 replay · T03 key reuse · T04 rollback releases the key
 *  T05 concurrency · T06 tenant/user scoping · T07 48h window · T08 canonical
 *  hash · T09 offline replay (upload the same list five times).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  buildContext,
  contextStore,
  IdempotencyService,
  payloadHash,
  runIdempotent,
} from '@ucs/kernel';
import { IdempotencyKeyMissing, IdempotencyKeyReused } from '@ucs/shared';
import {
  connectAs,
  createTestDatabase,
  executorFor,
  inTenantTx,
  TENANT_A,
  TENANT_B,
  withRoleConnectionLimit,
} from '../../tools/db/test-db';

let db: { name: string; drop: () => Promise<void> };
let app: Client;
let service: IdempotencyService;
const USER_1 = '00000000-0000-7000-8000-000000000001';
const USER_2 = '00000000-0000-7000-8000-000000000002';

beforeAll(async () => {
  db = await createTestDatabase('ucs_k10');
  app = await connectAs('app_sample', db.name);
  service = new IdempotencyService(contextStore);
}, 120_000);

afterEach(async () => {
  // Both the key ledger AND the effect table must be cleared: itemCount()
  // counts every row in the tenant, so a leftover effect from the previous case
  // would make the next assertion pass or fail for the wrong reason.
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await inTenantTx(app, { tenantId }, async () => {
      await app.query(`DELETE FROM sample.idempotency_key`);
      await app.query(`DELETE FROM sample.item`);
    });
  }
});

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await db?.drop();
});

/** Count the effects this key produced, as the owning tenant may read them. */
async function itemCount(tenantId = TENANT_A): Promise<number> {
  const r = await inTenantTx(app, { tenantId }, async () =>
    app.query<{ c: string }>(`SELECT count(*)::text AS c FROM sample.item`),
  );
  return Number(r.rows[0]!.c);
}

/**
 * Run one request inside a transaction, with the request context bound exactly
 * as the HTTP layer binds it. `work` is the endpoint body.
 */
async function request<T>(
  options: {
    tenantId?: string;
    userId?: string;
    key: string | null;
    payload: unknown;
    ttlHours?: number;
    now?: () => Date;
    client?: Client;
  },
  work: (tx: ReturnType<typeof executorFor>) => Promise<T>,
): Promise<{ duplicate: boolean; body: T; headers: Record<string, string> }> {
  const tenantId = options.tenantId ?? TENANT_A;
  const userId = options.userId ?? USER_1;
  const client = options.client ?? app;
  const ctx = buildContext({ tenantId, userId, client: 'test' });

  return contextStore.run(ctx, async () =>
    inTenantTx(client, { tenantId, userId }, async () => {
      const tx = executorFor(client);
      const result = await runIdempotent(service, {
        metadata: {
          schema: 'sample',
          ...(options.ttlHours === undefined ? {} : { ttlHours: options.ttlHours }),
        },
        request: { idempotencyKey: options.key, payload: options.payload },
        tx,
        work: () => work(tx),
        // K10-T07 drives the retention window with a fake clock; without this
        // the service would measure expiry against wall-clock time and no test
        // could ever cross the 48h boundary deterministically.
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      return { duplicate: result.duplicate, body: result.body as T, headers: result.headers };
    }),
  );
}

/** The endpoint body: create one item and return its id. */
async function createItem(tx: ReturnType<typeof executorFor>): Promise<{ itemId: string }> {
  const itemId = randomUUID();
  await tx.execute(
    `INSERT INTO sample.item (id, tenant_id, public_id, name, seq)
     VALUES ($1, NULLIF(current_setting('app.tenant_id', true), '')::uuid, $2, $3, 1)`,
    [itemId, `itm_${itemId.slice(0, 8)}`, 'created'],
  );
  return { itemId };
}

describe('[K10-T01] طلب كتابة بلا Idempotency-Key يُرفض بـ400', () => {
  it('rejects a marked write with no key before touching the database', async () => {
    for (const key of [null, '', '   ']) {
      const err = await request({ key, payload: { a: 1 } }, createItem)
        .then(() => null)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(IdempotencyKeyMissing);
      expect((err as IdempotencyKeyMissing).httpStatus).toBe(400);
      expect((err as IdempotencyKeyMissing).code).toBe('IDEMPOTENCY_KEY_MISSING');
    }

    // Nothing was written — the rejection happened before any claim.
    expect(await itemCount()).toBe(0);
  });
});

describe('[K10-T02] المفتاح نفسه يعيد الرد المخزَّن دون تنفيذ ثانٍ', () => {
  it('executes once and replays the stored response with a DUPLICATE marker', async () => {
    const key = randomUUID();
    const payload = { name: 'x', amount: 10 };

    const first = await request({ key, payload }, createItem);
    expect(first.duplicate).toBe(false);
    expect(first.headers['Idempotency-Replayed']).toBe('false');
    expect(await itemCount()).toBe(1);

    const second = await request({ key, payload }, createItem);

    // Same body, byte for byte, and clearly marked as a replay (K10-T02).
    expect(second.duplicate).toBe(true);
    expect(second.headers['Idempotency-Status']).toBe('DUPLICATE');
    expect(second.headers['Idempotency-Replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    // The decisive assertion: the work did not run a second time.
    expect(await itemCount()).toBe(1);
  });
});

describe('[K10-T03] المفتاح نفسه بحمولة مختلفة يُرجع 422', () => {
  it('rejects reuse with a different payload and does not execute', async () => {
    const key = randomUUID();

    await request({ key, payload: { name: 'first' } }, createItem);
    expect(await itemCount()).toBe(1);

    const err = await request({ key, payload: { name: 'second' } }, createItem)
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(IdempotencyKeyReused);
    expect((err as IdempotencyKeyReused).httpStatus).toBe(422);
    expect((err as IdempotencyKeyReused).code).toBe('IDEMPOTENCY_KEY_REUSED');

    // The conflicting request changed nothing.
    expect(await itemCount()).toBe(1);
  });
});

describe('[K10-T04] إلغاء معاملة العمل يلغي تسجيل المفتاح', () => {
  it('releases the key when the work rolls back, so a retry really executes', async () => {
    const key = randomUUID();
    const payload = { name: 'rollback' };

    // First attempt: work succeeds, then the transaction dies before COMMIT.
    await expect(
      request({ key, payload }, async (tx) => {
        await createItem(tx);
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');

    // The effect AND the key row were discarded together.
    expect(await itemCount()).toBe(0);
    const rows = await inTenantTx(app, { tenantId: TENANT_A }, async () =>
      app.query(`SELECT 1 FROM sample.idempotency_key WHERE key = $1`, [key]),
    );
    expect(rows.rowCount).toBe(0);

    // The retry therefore runs the work for real instead of replaying nothing.
    const retry = await request({ key, payload }, createItem);
    expect(retry.duplicate).toBe(false);
    expect(await itemCount()).toBe(1);
  });
});

describe('[K10-T05] طلبان متزامنان بالمفتاح نفسه: ينفَّذ واحد فقط', () => {
  it('lets exactly one concurrent request execute and the other replay', async () => {
    const key = randomUUID();
    const payload = { name: 'concurrent' };

    await withRoleConnectionLimit('app_sample', 8, async () => {
      const c1 = await connectAs('app_sample', db.name);
      const c2 = await connectAs('app_sample', db.name);
      try {
        // Both requests start in their own transaction. The second INSERT is
        // blocked by the unique index until the first transaction resolves, so
        // the outcome is decided by the database, not by timing.
        const [a, b] = await Promise.all([
          request({ key, payload, client: c1 }, createItem),
          request({ key, payload, client: c2 }, createItem),
        ]);

        const duplicates = [a.duplicate, b.duplicate].filter(Boolean).length;
        expect(duplicates).toBe(1);
        expect(await itemCount()).toBe(1);
      } finally {
        await c1.end().catch(() => undefined);
        await c2.end().catch(() => undefined);
      }
    });
  });
});

describe('[K10-T06] المفتاح محصور بالمستأجر والمستخدم', () => {
  it('does not collide across tenants or across users of one tenant', async () => {
    const key = randomUUID();
    const payload = { name: 'scoped' };

    const mine = await request({ key, payload }, createItem);
    expect(mine.duplicate).toBe(false);

    // Same key, same payload, different tenant: a different caller entirely.
    const otherTenant = await request({ tenantId: TENANT_B, key, payload }, createItem);
    expect(otherTenant.duplicate).toBe(false);

    // Same key, different user of the same tenant: also independent.
    const otherUser = await request({ userId: USER_2, key, payload }, createItem);
    expect(otherUser.duplicate).toBe(false);

    // One effect per (tenant, user) scope.
    expect(await itemCount(TENANT_A)).toBe(2);
    expect(await itemCount(TENANT_B)).toBe(1);

    // And the original key still replays only for its own owner.
    const replay = await request({ key, payload }, createItem);
    expect(replay.duplicate).toBe(true);
    expect(await itemCount(TENANT_A)).toBe(2);
  });
});

describe('[K10-T07] نافذة الاحتفاظ 48 ساعة', () => {
  it('treats an expired key as new', async () => {
    const key = randomUUID();
    const payload = { name: 'ttl' };
    const t0 = new Date('2026-01-01T00:00:00Z');

    const first = await request({ key, payload, now: () => t0 }, createItem);
    expect(first.duplicate).toBe(false);

    // Still inside the window: a replay.
    const inside = await request(
      { key, payload, now: () => new Date(t0.getTime() + 47 * 3_600_000) },
      createItem,
    );
    expect(inside.duplicate).toBe(true);
    expect(await itemCount()).toBe(1);

    // Past 48 hours the key no longer counts: the request is new again.
    const after = await request(
      { key, payload, now: () => new Date(t0.getTime() + 49 * 3_600_000) },
      createItem,
    );
    expect(after.duplicate).toBe(false);
    expect(await itemCount()).toBe(2);
  });
});

describe('[K10-T08] تجزئة الحمولة مطبّعة', () => {
  it('ignores object key order but respects array order', () => {
    // Same meaning, different serialisation order.
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      payloadHash({ b: { d: 3, c: 2 }, a: 1 }),
    );

    // Nested key order is also irrelevant.
    expect(payloadHash({ outer: { z: 1, y: 2 } })).toBe(payloadHash({ outer: { y: 2, z: 1 } }));

    // Arrays are ordered data: a reordered list is a different payload.
    expect(payloadHash([1, 2])).not.toBe(payloadHash([2, 1]));

    // Different values must differ, and the hash is stable in shape.
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('[K10-T09] رفع القائمة نفسها 5 مرات يُنتج أثراً واحداً', () => {
  it('collapses five identical offline uploads into one effect', async () => {
    // Offline attendance: the same roster is uploaded repeatedly after a
    // reconnect, and each upload carries the client's own Idempotency-Key.
    const uploadKey = randomUUID();
    const roster = {
      courseId: randomUUID(),
      sessionDate: '2026-03-01',
      present: ['s1', 's2', 's3'],
    };

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await request({ key: uploadKey, payload: roster }, createItem));
    }

    expect(outcomes[0]!.duplicate).toBe(false);
    expect(outcomes.slice(1).every((o) => o.duplicate)).toBe(true);
    expect(await itemCount()).toBe(1);
  });
});
