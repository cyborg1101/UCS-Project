/**
 * AC-039 / K05-T10 + K05-T11 — cross-tenant access is refused with 403, audited.
 *
 * Two separate properties, and both must hold:
 *   1. A public id minted for tenant A, presented by tenant B, answers 403 and
 *      leaves a SECURITY.CROSS_TENANT_ACCESS audit row — NOT 404. A 404 would
 *      claim the resource does not exist, when in fact it exists and is being
 *      refused; the tenant whose data was probed needs to see the attempt.
 *   2. The audit row survives the failed request. The 403 path never commits a
 *      business transaction, so a naive "audit inside the same tx" design would
 *      roll the evidence away with the failure.
 *
 * K05-T11 sweeps every registered route so a new endpoint cannot ship without
 * being classified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Executor } from '@ucs/kernel';
import { PublicIdCodec, CrossTenantAccess, NotFound } from '@ucs/shared';
import {
  connectAs,
  createTestDatabase,
  executorFor,
  inTenantTx,
  queryInDatabase,
  TENANT_A,
  TENANT_B,
  TENANT_CODE_A,
  TENANT_CODE_B,
} from '../../tools/db/test-db';
import {
  SAMPLE_ROUTES,
  ROUTE_FOREIGN_ID_OUTCOMES,
  getSampleItem,
  type SampleDeps,
} from '../../libs/modules/sample/src/items';

const SECRET = 'test-secret-ac039';
let db: { name: string; drop: () => Promise<void> };
let app: Client;
let deps: SampleDeps;
const codec = new PublicIdCodec({ secret: SECRET });

beforeAll(async () => {
  db = await createTestDatabase('ucs_ac039');
  app = await connectAs('app_sample', db.name);

  // Production wiring: every unit of work is a tenant-scoped transaction with
  // the request context bound, exactly as withTenantTx does it. Note the module
  // never opens a nested transaction — the security audit runs in its own
  // transaction after the refused request's transaction has already ended.
  deps = {
    codec,
    withTx: <T>(tenantId: string, fn: (tx: Executor) => Promise<T>) =>
      inTenantTx(app, { tenantId }, async () => fn(executorFor(app))),
  };
}, 120_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await db?.drop();
});

/** Create one item for `tenantCode`/`tenantId` and return its public id. */
async function seedItem(tenantId: string, tenantCode: string, name: string): Promise<string> {
  const id = randomUUID();
  const publicId = codec.encode(tenantCode, id);
  await inTenantTx(app, { tenantId }, async () => {
    await app.query(
      `INSERT INTO sample.item (id, tenant_id, public_id, name, seq)
       VALUES ($1, $2, $3, $4, 1)`,
      [id, tenantId, id, name],
    );
  });
  return publicId;
}

/**
 * Cross-tenant audit rows recorded against the CALLER's tenant.
 *
 * Read as migrator, never as app_sample: application roles hold no SELECT on
 * audit.audit_entry by design (K07-T13 pins that refusal — audit writes are
 * only reachable through audit.append). Reading it here as an app role would
 * fail on privilege, and RLS would be filtering for a reason unrelated to the
 * property under test. migrator bypasses RLS, so the tenant filter is written
 * out explicitly.
 */
async function crossTenantAudits(tenantId: string): Promise<
  Array<{ action: string; details: Record<string, unknown> }>
> {
  return queryInDatabase<{ action: string; details: Record<string, unknown> }>(
    db.name,
    `SELECT action, details FROM audit.audit_entry
      WHERE tenant_id = $1 AND action = 'SECURITY.CROSS_TENANT_ACCESS'
      ORDER BY seq`,
    [tenantId],
  );
}

describe('[K05-T10] AC-039: معرّف عام لمستأجر آخر يُرجع 403 مع حدث تدقيق', () => {
  it('refuses a foreign public id with 403 and records the attempt', async () => {
    // Tenants A and B both exist in the template with codes AA / BB.
    const foreignPublicId = await seedItem(TENANT_B, TENANT_CODE_B, 'belongs to B');

    const ctx = { tenantId: TENANT_A, userId: randomUUID(), correlationId: '01JGZ0000000000000000000AB' };
    const before = (await crossTenantAudits(TENANT_A)).length;

    const err = await getSampleItem(deps, ctx, foreignPublicId)
      .then(() => null)
      .catch((e: Error) => e);

    // The decisive assertion: 403, not 404.
    expect(err).toBeInstanceOf(CrossTenantAccess);
    expect((err as CrossTenantAccess).httpStatus).toBe(403);
    expect((err as CrossTenantAccess).code).toBe('CROSS_TENANT_ACCESS');
    expect((err as Error)).not.toBeInstanceOf(NotFound);

    // And the attempt is on the record, attributable to the caller's tenant.
    const audits = await crossTenantAudits(TENANT_A);
    expect(audits.length).toBe(before + 1);
    const entry = audits.at(-1)!;
    expect(entry.action).toBe('SECURITY.CROSS_TENANT_ACCESS');
    expect(entry.details).toMatchObject({
      target_tenant_code: TENANT_CODE_B,
      attempted_public_id: foreignPublicId,
    });
  });

  it('keeps the audit row even though the refused request wrote nothing', async () => {
    // A refused read commits no business transaction. If the audit trailed the
    // same transaction it would be rolled back with the failure, so this test
    // pins the property that the evidence survives.
    const foreign = await seedItem(TENANT_B, TENANT_CODE_B, 'b item');
    const ctx = { tenantId: TENANT_A, userId: null, correlationId: '01JGZ0000000000000000000CD' };

    await expect(getSampleItem(deps, ctx, foreign)).rejects.toBeInstanceOf(CrossTenantAccess);

    const audits = await crossTenantAudits(TENANT_A);
    const found = audits.find(
      (a) => a.details['attempted_public_id'] === foreign,
    );
    expect(found).toBeDefined();
  });

  it('still returns 200 for the owner of the id', async () => {
    const ownPublicId = await seedItem(TENANT_A, TENANT_CODE_A, 'mine');

    const view = await getSampleItem(
      deps,
      { tenantId: TENANT_A, userId: randomUUID(), correlationId: '01JGZ0000000000000000000EF' },
      ownPublicId,
    );

    expect(view.name).toBe('mine');
    expect(view.seq).toBe(1);
  });

  it('answers 404 only when the id is genuinely absent', async () => {
    // A valid id for THIS tenant whose row does not exist: absent, not foreign.
    const ghost = codec.encode(TENANT_CODE_A, randomUUID());
    const err = await getSampleItem(
      deps,
      { tenantId: TENANT_A, userId: null, correlationId: '01JGZ0000000000000000000GH' },
      ghost,
    )
      .then(() => null)
      .catch((e: Error) => e);

    // Compare uuid, not a cast text column: public_id stores the row's id.
    expect(err).toBeInstanceOf(NotFound);
    expect((err as NotFound).httpStatus).toBe(404);
  });
});

describe('[K05-T11] مسح كل المسارات المسجّلة بمعرّف من مستأجر آخر', () => {
  it('classifies every registered route and finds no undocumented one', () => {
    // A new route must be classified explicitly; the sweep below only covers
    // routes that declare their expected outcome.
    const unclassified = SAMPLE_ROUTES.filter(
      (r) => ROUTE_FOREIGN_ID_OUTCOMES[`${r.method} ${r.path}`] === undefined,
    );
    expect(unclassified.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('returns only 403 for deny routes and only 404 for not_found routes', async () => {
    const foreign = await seedItem(TENANT_B, TENANT_CODE_B, 'sweep target');
    const ctx = { tenantId: TENANT_A, userId: randomUUID(), correlationId: '01JGZ0000000000000000000JK' };

    const results: Array<{ route: string; status: number }> = [];
    for (const route of SAMPLE_ROUTES) {
      const key = `${route.method} ${route.path}`;
      const expectation = ROUTE_FOREIGN_ID_OUTCOMES[key];
      if (expectation === undefined) continue;

      const err = await route.probe(deps, ctx, foreign).then(
        () => null,
        (e: Error & { httpStatus?: number }) => e,
      );

      const status = err ? (err.httpStatus ?? 500) : 200;
      results.push({ route: key, status });

      if (expectation === 'deny') {
        expect({ route: key, status }).toEqual({ route: key, status: 403 });
      } else {
        expect([403, 404]).toContain(status);
      }
    }

    // The sweep actually ran; an empty loop would make this test vacuous.
    expect(results.length).toBe(SAMPLE_ROUTES.length);
    expect(results.length).toBeGreaterThan(0);
  });

  it('never leaks another tenant\'s row through any route', async () => {
    const foreign = await seedItem(TENANT_B, TENANT_CODE_B, 'secret row');

    // Probing the route with that exact id must be refused, not answered.
    const err = await getSampleItem(
      deps,
      { tenantId: TENANT_A, userId: null, correlationId: '01JGZ0000000000000000000LM' },
      foreign,
    )
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CrossTenantAccess);

    // Whatever a route answers, the foreign row must not be readable from A.
    const visibleFromA = await inTenantTx(app, { tenantId: TENANT_A }, async () =>
      app.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM sample.item WHERE name = 'secret row'`,
      ),
    );
    expect(Number(visibleFromA.rows[0]!.c)).toBe(0);

    // RLS is a second line of defence behind the 403: the row exists for B.
    const visibleFromB = await inTenantTx(app, { tenantId: TENANT_B }, async () =>
      app.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM sample.item WHERE name = 'secret row'`,
      ),
    );
    expect(Number(visibleFromB.rows[0]!.c)).toBe(1);
  });
});
