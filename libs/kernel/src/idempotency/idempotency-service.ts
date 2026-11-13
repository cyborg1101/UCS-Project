import { AppError, IdempotencyKeyReused } from '@ucs/shared';
import type { Executor } from '../db/tenant-database';
import type { ContextStore } from '../context/request-context';
import { payloadHash } from './hash';

/**
 * Idempotency (K-10).
 *
 * The rule the whole component exists to enforce: the key is claimed **inside
 * the same transaction as the work**. That single decision gives three
 * properties for free:
 *
 *  - K10-T04: if the work rolls back, the key row rolls back with it, so a
 *    retry genuinely executes instead of being answered with a response for
 *    work that never happened.
 *  - K10-T05: a concurrent duplicate's INSERT ... ON CONFLICT DO NOTHING blocks
 *    until the first transaction resolves. If it committed, the duplicate reads
 *    the stored response; if it rolled back, the duplicate claims the key
 *    itself. No polling, no lock table, no "in progress" row that survives a
 *    crash.
 *  - K10-T02: the response is persisted next to the key, so a replay returns
 *    exactly what the first call returned, without running the work twice.
 *
 * The table is `(tenant_id, user_id, key)`, not `(tenant_id, key)`: the key
 * namespace belongs to the caller, so two different users of one tenant using
 * the same key must not collide (K10-T06).
 */
export interface IdempotencyRunOptions {
  /** Module schema owning the `idempotency_key` table. */
  schema: string;
  /** Client-supplied `Idempotency-Key`. */
  key: string;
  /** The request body the key is bound to. */
  payload: unknown;
  /** K10-T07 retention window. Defaults to the SAD's 48 hours. */
  ttlHours?: number;
  /** Injectable clock so the retention window can be exercised (K10-T07). */
  now?: () => Date;
}

export interface IdempotentOutcome<T> {
  /** true when this call replayed a stored response instead of doing the work. */
  duplicate: boolean;
  response: T;
}

export const DEFAULT_TTL_HOURS = 48;

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export class IdempotencyService {
  readonly #store: ContextStore;
  readonly #defaultTtlHours: number;

  constructor(store: ContextStore, options: { ttlHours?: number } = {}) {
    this.#store = store;
    this.#defaultTtlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  }

  /**
   * Run `work` at most once per (tenant, user, key).
   *
   * `work` MUST use the `tx` it is handed for every write, otherwise the key
   * claim and the effect land in different transactions and the guarantee is
   * lost.
   */
  async run<T>(
    tx: Executor,
    options: IdempotencyRunOptions,
    work: (tx: Executor) => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    if (!SCHEMA_RE.test(options.schema)) {
      throw new AppError('INVALID_SCHEMA_NAME', 'errors.validation_failed', 500, {
        schema: options.schema,
      });
    }
    const ctx = this.#store.get();
    const tenantId = ctx.tenant_id;
    const userId = ctx.user_id;
    if (!tenantId) throw new AppError('TENANT_REQUIRED', 'errors.tenant_required', 400);
    if (!userId) throw new AppError('USER_REQUIRED', 'errors.user_required', 400);

    const schema = options.schema;
    const now = (options.now ?? (() => new Date()))();
    const ttlHours = options.ttlHours ?? this.#defaultTtlHours;
    const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
    const requestHash = payloadHash(options.payload);

    // K10-T07: an expired key is not a key. Dropping it first means the request
    // is treated as new rather than replayed forever.
    await tx.execute(
      `DELETE FROM ${schema}.idempotency_key
        WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND expires_at <= $4`,
      [tenantId, userId, options.key, now],
    );

    // Claim the key in the caller's transaction (K10-T04 / K10-T05).
    const claimed = await tx.execute(
      `INSERT INTO ${schema}.idempotency_key
         (tenant_id, user_id, key, request_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5, $6)
       ON CONFLICT (tenant_id, user_id, key) DO NOTHING`,
      [tenantId, userId, options.key, requestHash, now, expiresAt],
    );

    if (claimed === 1) {
      const response = await work(tx);
      await tx.execute(
        `UPDATE ${schema}.idempotency_key
            SET status = 'COMPLETED', response = $4
          WHERE tenant_id = $1 AND user_id = $2 AND key = $3`,
        [tenantId, userId, options.key, JSON.stringify(response ?? null)],
      );
      return { duplicate: false, response };
    }

    // The key belongs to another transaction, which has already resolved: our
    // INSERT could only conflict once that transaction ended.
    const existing = await tx.queryOne<{ request_hash: string; response: T | null }>(
      `SELECT request_hash, response
         FROM ${schema}.idempotency_key
        WHERE tenant_id = $1 AND user_id = $2 AND key = $3`,
      [tenantId, userId, options.key],
    );

    if (!existing) {
      // The owner rolled back between our INSERT and this read, so the key is
      // free again. Refusing is the safe answer: silently running the work here
      // could duplicate it if the owner's rollback was a transient retry.
      throw new AppError('IDEMPOTENCY_KEY_CONTENDED', 'errors.idempotency_key_reused', 409, {
        key: options.key,
      });
    }

    if (existing.request_hash !== requestHash) {
      // K10-T03: same key, different payload — the client reused a key it must
      // not reuse. 422, never a silent second execution.
      throw new IdempotencyKeyReused({ key: options.key });
    }

    return { duplicate: true, response: existing.response as T };
  }
}
