import {
  CrossTenantAccess,
  NotFound,
  PublicIdCodec,
  type AppError,
} from '@ucs/shared';
import type { Executor } from '@ucs/kernel';

/**
 * Sample module — the reference implementation every generated module copies.
 *
 * AC-039 lives here: a public id belonging to another tenant must answer **403
 * with a SECURITY.CROSS_TENANT_ACCESS audit entry**, never 404. The distinction
 * matters because the id is cryptographically valid — it was minted for a real
 * row that really exists. Answering 404 would pretend the resource is absent,
 * which both hides a security event from the tenant's administrators and gives
 * an attacker a clean signal that the id format was accepted.
 *
 * The audit entry is written in its OWN transaction, after the failed request's
 * transaction has rolled back. A security event that disappears because the
 * request it describes failed is not a security event at all.
 */
export interface SampleDeps {
  codec: PublicIdCodec;
  /** Opens a tenant-scoped transaction, exactly as withTenantTx does. */
  withTx: <T>(tenantId: string, fn: (tx: Executor) => Promise<T>) => Promise<T>;
}

export interface SampleRequestContext {
  tenantId: string;
  userId: string | null;
  correlationId: string;
}

export interface SampleItemView {
  publicId: string;
  name: string;
  seq: number;
}

/** Action code, duplicated from the audit module to keep the boundary one-way. */
export const CROSS_TENANT_AUDIT_ACTION = 'SECURITY.CROSS_TENANT_ACCESS';

/** The authoritative tenant code. Read from the database, never from a header. */
async function tenantCodeOf(tx: Executor, tenantId: string): Promise<string> {
  const row = await tx.queryOne<{ code: string }>(
    `SELECT code FROM platform.tenant WHERE id = $1`,
    [tenantId],
  );
  if (!row) throw new NotFound({ reason: 'tenant_not_found' });
  return row.code;
}

/**
 * Record a refused cross-tenant read in its own committed transaction.
 *
 * The row is attributed to the CALLER's tenant: the tenant whose user attempted
 * the access is the one that needs to see it. Details carry the target tenant
 * code and the attempted public id so an investigator can reconstruct the
 * attempt without a second lookup.
 */
async function recordCrossTenantAccess(
  deps: SampleDeps,
  ctx: SampleRequestContext,
  publicId: string,
  targetTenantCode: string,
): Promise<void> {
  await deps.withTx(ctx.tenantId, async (tx) => {
    await tx.query(`SELECT audit.append($1, $2, $3, $4, $5::jsonb, $6)`, [
      CROSS_TENANT_AUDIT_ACTION,
      'sample.item',
      null,
      null,
      JSON.stringify({
        attempted_public_id: publicId,
        target_tenant_code: targetTenantCode,
        caller_tenant_id: ctx.tenantId,
      }),
      null,
    ]);
  });
}

/**
 * GET /api/v1/sample/items/:publicId
 *
 * Order matters:
 *  1. decode the id against the CALLER's tenant code → 403 on mismatch;
 *  2. only then query, so a foreign id never reaches the row lookup;
 *  3. RLS scopes the SELECT as a second, independent line of defence.
 */
export async function getSampleItem(
  deps: SampleDeps,
  ctx: SampleRequestContext,
  publicId: string,
): Promise<SampleItemView> {
  let tenantCode: string;
  try {
    tenantCode = await deps.withTx(ctx.tenantId, (tx) => tenantCodeOf(tx, ctx.tenantId));
  } catch (err) {
    throw err;
  }

  let itemId: string;
  try {
    itemId = deps.codec.decodeForTenant(publicId, tenantCode);
  } catch (err) {
    const appErr = err as AppError;
    if (appErr instanceof CrossTenantAccess) {
      // AC-039: the attempt is recorded before the caller sees the 403.
      const target = String((appErr.details as { targetTenant?: unknown }).targetTenant ?? '');
      await recordCrossTenantAccess(deps, ctx, publicId, target);
    }
    throw err;
  }

  const row = await deps.withTx(ctx.tenantId, (tx) =>
    tx.queryOne<{ public_id: string; name: string; seq: string }>(
      // The public id is an encoded uuid, so the row is found by primary key
      // once the decoder has proved the id belongs to this tenant.
      `SELECT public_id, name, seq FROM sample.item WHERE id = $1`,
      [itemId],
    ),
  );

  // The id was valid for this tenant but the row is gone: a genuine 404.
  if (!row) throw new NotFound({ publicId });

  return { publicId: row.public_id, name: row.name, seq: Number(row.seq) };
}

/**
 * Every route this module registers.
 *
 * The cross-tenant sweep (K05-T11) walks this list, so a new route cannot be
 * added without also being classified in `ROUTE_FOREIGN_ID_OUTCOMES`. That is
 * what makes the sweep automatic rather than a hand-maintained checklist.
 */
export interface SampleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Invoke the route with a public id belonging to another tenant. */
  probe: (deps: SampleDeps, ctx: SampleRequestContext, foreignPublicId: string) => Promise<unknown>;
}

export const SAMPLE_ROUTES: readonly SampleRoute[] = [
  {
    method: 'GET',
    path: '/api/v1/sample/items/:publicId',
    probe: (deps, ctx, foreignPublicId) => getSampleItem(deps, ctx, foreignPublicId),
  },
];

/**
 * Documented acceptable outcome for a foreign-id probe, per route.
 *
 * Only 403 or 404 are acceptable, and `deny` (403) is the default expectation:
 * a cross-tenant id should be refused, not merely absent. The map exists so the
 * choice is explicit and reviewable per route.
 */
export const ROUTE_FOREIGN_ID_OUTCOMES: Readonly<Record<string, 'deny' | 'not_found'>> = {
  'GET /api/v1/sample/items/:publicId': 'deny',
};
