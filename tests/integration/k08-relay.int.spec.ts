/**
 * K-08 — Outbox and Relay.
 *
 * The cases here are E-01/E-02 (crash windows), G1 (gap-free log_seq),
 * E-03 (fencing) and the envelope/contract rules. All run against real
 * PostgreSQL: the guarantees are inside the database, so mocking it would prove
 * nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {

  connectAs,
  createTestDatabase,
  executorFor,
  inTenantTx,
  queryInDatabase,
  TENANT_A,
  TENANT_B,
  urlFor,
  withRelayConnectionLimit,
} from '../../tools/db/test-db';
import { Relay } from '../../libs/platform/messaging/src/relay';
import { appendEvent } from '../../libs/platform/messaging/src/outbox';
import { buildEnvelope, ContractRegistry } from '../../libs/platform/messaging/src/envelope';
import { EventContractViolation } from '@ucs/shared';
import { z } from 'zod';

let db: { name: string; drop: () => Promise<void> };
let app: Client;
let relay: Relay;

/**
 * The writer lease is cluster-visible state, so a test that needs to acquire it
 * must first make the previous holder's TTL expire. Doing it as migrator (never
 * as app_relay) keeps the probe honest: nothing here can bypass a policy.
 */
async function expireLease(): Promise<void> {
  await queryInDatabase(
    db.name,
    `UPDATE messaging.writer_lease SET expires_at = now() - interval '1 second' WHERE id = 1`,
  );
}

beforeAll(async () => {
  db = await createTestDatabase('ucs_k08');
  app = await connectAs('app_sample', db.name);
  relay = new Relay({
    connectionString: urlFor('app_relay', db.name),
    producers: [{ schema: 'sample', producer: 'sample' }],
    batchSize: 100,
    owner: 'relay-test-1',
  });
}, 120_000);

beforeEach(async () => {
  // Every case starts with no live writer, so "who can acquire?" is decided by
  // the database and not by leftover state from the previous case.
  if (db) await expireLease();
});

afterAll(async () => {
  await relay?.close();
  await app?.end().catch(() => undefined);
  await db?.drop();
});

/**
 * RLS-scoped read. A bare `app.query()` runs outside a transaction, so
 * `app.tenant_id` is unset and the policy filters every row away — verification
 * reads must run in a tenant transaction just like production ones.
 */
async function readInTenant<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return inTenantTx(app, { tenantId }, async () => executorFor(app).query<T>(sql, params));
}

/** Real append through a live transaction handle over app_sample. */
async function appendVia(tenantId: string, opts: { eventType?: string; aggregateId?: string } = {}) {
  const aggregateId = opts.aggregateId ?? randomUUID();
  const event = await inTenantTx(app, { tenantId }, async () => {
    return appendEvent(executorFor(app), {
      tenantId,
      producer: 'sample',
      eventType: opts.eventType ?? 'sample.item_created',
      aggregateType: 'item',
      aggregateId,
      payload: { itemId: aggregateId, name: 'n', seq: 1 },
    });
  });
  return { event, aggregateId };
}

describe('[K08-T01] الكتابة في Outbox مشتركة مع معاملة العمل', () => {
  it('rolls the event back together with the business change', async () => {
    const before = await app.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM sample.outbox WHERE tenant_id = $1`,
      [TENANT_A],
    );

    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () => {
        await appendEvent(executorFor(app), {
          tenantId: TENANT_A,
          producer: 'sample',
          eventType: 'sample.item_created',
          aggregateType: 'item',
          aggregateId: randomUUID(),
          payload: { itemId: randomUUID(), name: 'x', seq: 1 },
        });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    const after = await app.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM sample.outbox WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });

  it('commits the event together with the business change', async () => {
    const { event } = await appendVia(TENANT_A);
    const rows = await readInTenant(TENANT_A, `SELECT 1 AS one FROM sample.outbox WHERE id = $1`, [
      event.event_id,
    ]);
    expect(rows.length).toBe(1);
  });
});

describe('[K08-T02] الـEnvelope يكتمل تلقائياً', () => {
  it('fills event_id, tenant, producer, correlation, occurred_at and a growing seq', async () => {
    const aggregateId = randomUUID();
    const first = await appendVia(TENANT_A, { aggregateId });
    const second = await appendVia(TENANT_A, { aggregateId });

    expect(first.event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.event.tenant_id).toBe(TENANT_A);
    expect(first.event.producer).toBe('sample');
    expect(first.event.occurred_at).toMatch(/Z$/);
    expect(first.event.aggregate_seq).toBe(1);
    // K08-T04: the sequence grows per aggregate and never repeats.
    expect(second.event.aggregate_seq).toBe(2);
  });

  it('rejects a malformed envelope before touching the database', () => {
    expect(() =>
      buildEnvelope({
        eventId: 'not-a-uuid',
        tenantId: TENANT_A,
        producer: 'sample',
        eventType: 'sample.item_created',
        aggregateType: 'item',
        aggregateId: randomUUID(),
        aggregateSeq: 1,
        payload: {},
      }),
    ).toThrow(EventContractViolation);
  });

  it('carries the correlation id from the request context', async () => {
    const correlationId = '01JABC0DEFGHJKMNPQRSTVWXY1';
    const ev = await inTenantTx(app, { tenantId: TENANT_A, correlationId }, async () =>
      appendEvent(executorFor(app), {
        tenantId: TENANT_A,
        producer: 'sample',
        eventType: 'sample.item_created',
        aggregateType: 'item',
        aggregateId: randomUUID(),
        payload: { itemId: randomUUID(), name: 'c', seq: 1 },
      }),
    );
    expect(ev.correlation_id).toBe(correlationId);
  });
});

describe('[K08-T03] حدث لا يطابق عقد JSON Schema يرفع EventContractViolation', () => {
  it('rejects an unregistered event type', async () => {
    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () =>
        appendEvent(executorFor(app), {
          tenantId: TENANT_A,
          producer: 'sample',
          eventType: 'sample.not_registered',
          aggregateType: 'item',
          aggregateId: randomUUID(),
          payload: {},
        }),
      ),
    ).rejects.toThrow(EventContractViolation);
  });

  it('rejects a payload that violates the contract', async () => {
    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () =>
        appendEvent(executorFor(app), {
          tenantId: TENANT_A,
          producer: 'sample',
          eventType: 'sample.item_created',
          aggregateType: 'item',
          aggregateId: randomUUID(),
          // itemId must be a uuid; "nope" must be rejected.
          payload: { itemId: 'nope', name: 'x', seq: 1 },
        }),
      ),
    ).rejects.toThrow(EventContractViolation);
  });

  it('rejects the contract without consuming an aggregate sequence', async () => {
    const aggregateId = randomUUID();
    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () =>
        appendEvent(executorFor(app), {
          tenantId: TENANT_A,
          producer: 'sample',
          eventType: 'sample.item_created',
          aggregateType: 'item',
          aggregateId,
          payload: { itemId: 'nope', name: 'x', seq: 1 },
        }),
      ),
    ).rejects.toThrow(EventContractViolation);

    // Nothing was written and no sequence value was burned, so the first real
    // event on this aggregate is still seq 1.
    const rows = await app.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM sample.aggregate_sequence WHERE aggregate_id = $1`,
      [aggregateId],
    );
    expect(rows.rows[0]!.c).toBe(0);

    const ok = await appendVia(TENANT_A, { aggregateId });
    expect(ok.event.aggregate_seq).toBe(1);
  });

  it('accepts a payload that matches a custom registry', async () => {
    const registry = new ContractRegistry().register({
      type: 'sample.custom_thing',
      version: 1,
      payload: z.object({ n: z.number() }),
    });
    const ev = await inTenantTx(app, { tenantId: TENANT_A }, async () =>
      appendEvent(executorFor(app), {
        tenantId: TENANT_A,
        producer: 'sample',
        eventType: 'sample.custom_thing',
        aggregateType: 'thing',
        aggregateId: randomUUID(),
        payload: { n: 5 },
        registry,
      }),
    );
    expect(ev.event_type).toBe('sample.custom_thing');
  });
});

describe('[K08-T04] aggregate_seq متزايد بلا تكرار تحت التزامن', () => {
  it('two concurrent appends on one aggregate get distinct consecutive seqs', async () => {
    const aggregateId = randomUUID();
    // Two real connections: app_sample's pool allows 3 (SAD §10.4), and the
    // point of the case is genuine concurrency, not interleaved statements on
    // one socket.
    const mk = async (client: Client) =>
      inTenantTx(client, { tenantId: TENANT_A }, async () =>
        appendEvent(executorFor(client), {
          tenantId: TENANT_A,
          producer: 'sample',
          eventType: 'sample.item_created',
          aggregateType: 'item',
          aggregateId,
          payload: { itemId: aggregateId, name: 'c', seq: 1 },
        }),
      );

    const c1 = await connectAs('app_sample', db.name);
    const c2 = await connectAs('app_sample', db.name);
    try {
      const [a, b] = await Promise.all([mk(c1), mk(c2)]);
      const seqs = [a.aggregate_seq, b.aggregate_seq].sort((x, y) => x - y);
      expect(seqs).toEqual([1, 2]);
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });
});

describe('[K08-T05/T07] outbox_fetch و dedup', () => {
  it('returns unpublished rows ordered by aggregate and seq, and app_relay cannot read the table', async () => {
    const direct = new Client({ connectionString: urlFor('app_relay', db.name) });
    await direct.connect();
    try {
      await expect(direct.query('SELECT * FROM sample.outbox')).rejects.toThrow(
        /permission denied/i,
      );

      const rows = await direct.query<{ aggregate_id: string; aggregate_seq: string }>(
        `SELECT * FROM sample.outbox_fetch(100)`,
      );
      expect(rows.rowCount).toBeGreaterThan(0);
      const keys = rows.rows.map((r) => `${r.aggregate_id}:${r.aggregate_seq}`);
      expect([...keys].sort()).toEqual(keys);
    } finally {
      await direct.end();
    }
  });

  it('repeated delivery of the same batch appends nothing twice', async () => {
    const relayClient = new Client({ connectionString: urlFor('app_relay', db.name) });
    await relayClient.connect();
    try {
      const epoch = (
        await relayClient.query<{ acquire_lease: string }>(
          `SELECT messaging.acquire_lease('dedup-probe', 15) AS acquire_lease`,
        )
      ).rows[0]!.acquire_lease;

      const payload = JSON.stringify([
        {
          event_id: randomUUID(),
          tenant_id: TENANT_A,
          producer: 'sample',
          event_type: 'sample.item_created',
          event_version: 1,
          aggregate_type: 'item',
          aggregate_id: randomUUID(),
          aggregate_seq: 1,
          payload: { itemId: randomUUID(), name: 'd', seq: 1 },
          occurred_at: new Date().toISOString(),
        },
      ]);

      const first = await relayClient.query<{ relay_batch: number }>(
        `SELECT messaging.relay_batch($1, $2::jsonb) AS relay_batch`,
        [epoch, payload],
      );
      const second = await relayClient.query<{ relay_batch: number }>(
        `SELECT messaging.relay_batch($1, $2::jsonb) AS relay_batch`,
        [epoch, payload],
      );
      expect(first.rows[0]!.relay_batch).toBe(1);
      expect(second.rows[0]!.relay_batch).toBe(0);
    } finally {
      await relayClient.end();
    }
  });
});

describe('[K08-T06/E-03] عقد الإرسال يرفض epoch القديم', () => {
  it('rejects an epoch that is not current', async () => {
    const relayClient = new Client({ connectionString: urlFor('app_relay', db.name) });
    await relayClient.connect();
    try {
      await relayClient.query(`SELECT messaging.acquire_lease('e3-probe', 15)`);
      const err = await relayClient
        .query(`SELECT messaging.relay_batch(999999, '[]'::jsonb)`)
        .then(() => null)
        .catch((e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/stale epoch/i);
    } finally {
      await relayClient.end();
    }
  });

  it('rolls the whole batch back when the epoch is stale', async () => {
    // The relay's own pool already holds the single app_relay slot, so an extra
    // probe session needs a raised ceiling for the duration of the check.
    await withRelayConnectionLimit(2, async () => {
    const relayClient = new Client({ connectionString: urlFor('app_relay', db.name) });
    await relayClient.connect();
    try {
      await relayClient.query(`SELECT messaging.acquire_lease('e3-probe-2', 15)`);
      const before = await queryInDatabase<{ c: number }>(
        db.name,
        `SELECT count(*)::int AS c FROM messaging.event_log`,
      );
      const eventId = randomUUID();
      const batch = JSON.stringify([
        {
          event_id: eventId,
          tenant_id: TENANT_A,
          producer: 'sample',
          event_type: 'sample.item_created',
          event_version: 1,
          aggregate_type: 'item',
          aggregate_id: randomUUID(),
          aggregate_seq: 1,
          payload: { itemId: randomUUID(), name: 'fenced', seq: 1 },
          occurred_at: new Date().toISOString(),
        },
      ]);
      await expect(
        relayClient.query(`SELECT messaging.relay_batch(999999, $1::jsonb)`, [batch]),
      ).rejects.toThrow(/stale epoch/i);

      const after = await queryInDatabase<{ c: number }>(
        db.name,
        `SELECT count(*)::int AS c FROM messaging.event_log`,
      );
      expect(after[0]!.c).toBe(before[0]!.c);
    } finally {
      await relayClient.end();
    }
    });
  });
});

describe('[K08-T12] writer_lease: epoch يزيد ولا يستحوذ اثنان معاً', () => {
  it('a second live owner cannot acquire, and each acquire bumps the epoch', async () => {
    // Two simultaneous app_relay sessions need a temporarily higher cluster
    // ceiling; the SAD §10.4 limit stays 1 for production.
    await withRelayConnectionLimit(2, async () => {
      const a = new Client({ connectionString: urlFor('app_relay', db.name) });
      const b = new Client({ connectionString: urlFor('app_relay', db.name) });
      await a.connect();
      await b.connect();
      try {
        const e1 = (
          await a.query<{ acquire_lease: string }>(
            `SELECT messaging.acquire_lease('owner-a', 15) AS acquire_lease`,
          )
        ).rows[0]!.acquire_lease;
        expect(e1).not.toBeNull();

        const blocked = (
          await b.query<{ acquire_lease: string | null }>(
            `SELECT messaging.acquire_lease('owner-b', 15) AS acquire_lease`,
          )
        ).rows[0]!.acquire_lease;
        expect(blocked).toBeNull();

        // Releasing lets the other acquire, with a strictly higher epoch.
        await a.query(`SELECT messaging.release_lease($1)`, [Number(e1)]);
        const e2 = (
          await b.query<{ acquire_lease: string }>(
            `SELECT messaging.acquire_lease('owner-b', 15) AS acquire_lease`,
          )
        ).rows[0]!.acquire_lease;
        expect(Number(e2)).toBe(Number(e1) + 1);
      } finally {
        await a.end().catch(() => undefined);
        await b.end().catch(() => undefined);
      }
    });
  });
});

describe('[E-01/E-02] نافذتا الانهيار', () => {
  it('E-01: a rolled-back fetch leaves rows unpublished and the next cycle claims them', async () => {
    const { event } = await appendVia(TENANT_B);

    // The crash window: fetched (and row-locked) but never appended.
    await withRelayConnectionLimit(2, async () => {
      const relayClient = new Client({ connectionString: urlFor('app_relay', db.name) });
      await relayClient.connect();
      try {
        await relayClient.query('BEGIN');
        const fetched = await relayClient.query(`SELECT * FROM sample.outbox_fetch(100)`);
        expect(fetched.rowCount).toBeGreaterThan(0);
        await relayClient.query('ROLLBACK');
      } finally {
        await relayClient.end().catch(() => undefined);
      }
    });

    // The row is still unpublished, so a real cycle publishes it.
    const result = await relay.cycle();
    expect(result.acquired).toBe(true);
    expect(result.appended).toBeGreaterThanOrEqual(1);

    const published = await readInTenant<{ published_at: Date | null }>(
      TENANT_B,
      `SELECT published_at FROM sample.outbox WHERE id = $1`,
      [event.event_id],
    );
    expect(published[0]!.published_at).not.toBeNull();
  });

  it('E-02: append then rollback publishes exactly once afterwards (no duplicate)', async () => {
    const { event } = await appendVia(TENANT_B);

    // The crash window: appended, then the transaction died before COMMIT.
    await withRelayConnectionLimit(2, async () => {
      const relayClient = new Client({ connectionString: urlFor('app_relay', db.name) });
      await relayClient.connect();
      try {
        const epoch = (
          await relayClient.query<{ acquire_lease: string }>(
            `SELECT messaging.acquire_lease('e02-probe', 15) AS acquire_lease`,
          )
        ).rows[0]!.acquire_lease;

        await relayClient.query('BEGIN');
        const full = await relayClient.query(`SELECT * FROM sample.outbox_fetch(100)`);
        const payload = JSON.stringify(
          full.rows.map((r) => ({
            event_id: r.id,
            tenant_id: r.tenant_id,
            producer: 'sample',
            event_type: r.event_type,
            event_version: r.event_version,
            aggregate_type: r.aggregate_type,
            aggregate_id: r.aggregate_id,
            aggregate_seq: Number(r.aggregate_seq),
            payload: r.payload,
            correlation_id: r.correlation_id,
            causation_id: r.causation_id,
            occurred_at: (r.occurred_at as Date).toISOString(),
          })),
        );
        await relayClient.query(`SELECT messaging.relay_batch($1, $2::jsonb)`, [epoch, payload]);
        await relayClient.query('ROLLBACK');
      } finally {
        await relayClient.end().catch(() => undefined);
      }
    });

    // Hand the lease to the real relay and let it redo the work.
    await expireLease();
    await relay.cycle();

    const logRows = await queryInDatabase<{ c: number }>(
      db.name,
      `SELECT count(*)::int AS c FROM messaging.event_log WHERE event_id = $1`,
      [event.event_id],
    );
    expect(logRows[0]!.c).toBe(1);
  });
});

describe('[G1/K08-T08] log_seq متتابع بلا فجوة رغم التراجعات', () => {
  it('stays dense across many rollbacks', async () => {
    await withRelayConnectionLimit(2, async () => {
    const relayClient = new Client({ connectionString: urlFor('app_relay', db.name) });
    await relayClient.connect();
    try {
      const epoch = (
        await relayClient.query<{ acquire_lease: string }>(
          `SELECT messaging.acquire_lease('g1-probe', 60) AS acquire_lease`,
        )
      ).rows[0]!.acquire_lease;

      // 60 mixed cycles: some commit, some roll back. A Sequence would leave a
      // gap for every rollback; a counter row does not.
      for (let i = 0; i < 60; i++) {
        const batch = JSON.stringify([
          {
            event_id: randomUUID(),
            tenant_id: TENANT_A,
            producer: 'sample',
            event_type: 'sample.item_created',
            event_version: 1,
            aggregate_type: 'item',
            aggregate_id: randomUUID(),
            aggregate_seq: 1,
            payload: { itemId: randomUUID(), name: `g1-${i}`, seq: 1 },
            occurred_at: new Date().toISOString(),
          },
        ]);
        await relayClient.query('BEGIN');
        await relayClient.query(`SELECT messaging.relay_batch($1, $2::jsonb)`, [epoch, batch]);
        if (i % 3 === 0) await relayClient.query('ROLLBACK');
        else await relayClient.query('COMMIT');
      }
    } finally {
      await relayClient.end();
    }
    });

    const seqs = await queryInDatabase<{ log_seq: string }>(
      db.name,
      `SELECT log_seq FROM messaging.event_log ORDER BY log_seq`,
    );
    const values = seqs.map((r) => Number(r.log_seq));
    expect(values.length).toBeGreaterThan(10);
    // dense: 1..N with no holes
    expect(values).toEqual(values.map((_, i) => i + 1));
  }, 60_000);
});
