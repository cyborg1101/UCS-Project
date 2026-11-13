import type { Executor } from '@ucs/kernel';

/**
 * Audit append (K-07 client side).
 *
 * Always goes through audit.append() as a database function: application roles
 * hold no table privilege on audit.audit_entry, so an audit write cannot be
 * forged or skipped by writing the table directly. The call rides inside the
 * caller's transaction, which is what makes "no business effect without an
 * audit trail" true rather than aspirational.
 */
export interface AuditEntryInput {
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  purpose?: string | null;
  details?: Record<string, unknown> | null;
  actorRole?: string | null;
}

export class AuditService {
  constructor(private readonly tx: Executor) {}

  async append(entry: AuditEntryInput): Promise<number> {
    const rows = await this.tx.query<{ seq: string }>(
      `SELECT audit.append($1, $2, $3, $4, $5::jsonb, $6) AS seq`,
      [
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.purpose ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.actorRole ?? null,
      ],
    );
    return Number(rows[0]!.seq);
  }
}

/** Audit action codes used across the kernel (single source of truth). */
export const AUDIT_ACTIONS = {
  crossTenantAccess: 'SECURITY.CROSS_TENANT_ACCESS',
  authnDenied: 'SECURITY.AUTHN_DENIED',
  idempotencyReplay: 'SECURITY.IDEMPOTENCY_REPLAY',
  dlqSkip: 'MESSAGING.DLQ_SKIP',
  dlqReplay: 'MESSAGING.DLQ_REPLAY',
} as const;
