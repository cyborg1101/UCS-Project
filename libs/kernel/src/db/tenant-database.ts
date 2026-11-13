import { Pool, type PoolClient, type PoolConfig } from 'pg';
import {
  NestedTransaction,
  TxBoundaryViolation,
} from '@ucs/shared';
import type { ContextStore } from '../context/request-context';
import { buildContext } from '../context/request-context';

/**
 * withTenantTx (K-04).
 *
 * Design rules, all enforced here rather than by convention:
 *  - The raw pool is never exported; callers get a transaction handle only.
 *  - Tenant/user/correlation are set with set_config(..., true) — LOCAL to the
 *    transaction, which is what PgBouncer transaction pooling requires
 *    (SAD §10.2). A session-level SET would leak across borrowers.
 *  - Every transaction carries statement_timeout / lock_timeout /
 *    idle_in_transaction_session_timeout.
 *  - A nested call throws instead of silently opening a second transaction.
 *  - While the transaction is open the context is flagged; external I/O guards
 *    (fetch / module facades / mail) raise TxBoundaryViolation (P-05).
 */
export type Executor = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<number>;
};

export interface TxOptions {
  /** Defaults to the tenant in the active request context. */
  tenantId?: string | null;
  userId?: string | null;
  correlationId?: string | null;
  /** 'interactive' (api) or 'background' (jobs/relay). SAD §10.3. */
  profile?: TxProfile;
  /** Test hook: fake clock for time-dependent work inside the tx. */
  now?: () => Date;
}

export type TxProfile = 'interactive' | 'background';

export interface TimeoutProfile {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionMs: number;
}

export const TIMEOUTS: Record<TxProfile, TimeoutProfile> = {
  interactive: {
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 2_000,
    idleInTransactionMs: 10_000,
  },
  background: {
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 5_000,
    idleInTransactionMs: 30_000,
  },
};

export interface TenantDatabaseConfig {
  connectionString: string;
  max?: number;
  applicationName?: string;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

/** Minimal queryable surface, so a pg client and the pool both fit. */
type RawClient = Pick<PoolClient, 'query' | 'release'>;

function makeExecutor(client: RawClient): Executor {
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async queryOne<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return (res.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rowCount ?? 0;
    },
  };
}

export interface P05Options {
  /** 'development'|'test' throws, 'production' logs and counts (K04-T05). */
  mode?: 'development' | 'test' | 'production';
  onViolation?: (operation: string) => void;
}

export class TenantDatabase {
  readonly #pool: Pool;
  private readonly store: ContextStore;
  private readonly p05: P05Options;
  violationCount = 0;

  constructor(store: ContextStore, config: TenantDatabaseConfig, p05: P05Options = {}) {
    this.store = store;
    this.p05 = p05;
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.max ?? 3,
      application_name: config.applicationName ?? 'ums',
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 1_000,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    } satisfies PoolConfig);
  }

  /** Only used by readiness checks; never hands out a query interface. */
  async healthy(): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }

  stats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.#pool.totalCount,
      idle: this.#pool.idleCount,
      waiting: this.#pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  /**
   * Run `fn` inside a tenant-scoped transaction.
   * The callback receives only the Executor — never the raw client.
   */
  async withTenantTx<T>(options: TxOptions, fn: (tx: Executor) => Promise<T>): Promise<T> {
    // Workers/relay run outside an HTTP request. Without a bound context there
    // is no place to track transaction depth (P-05 marker, nesting guard), so
    // open a synthetic scope instead of throwing after borrowing a connection.
    if (!this.store.tryGet()) {
      const synthetic = buildContext({
        tenantId: options.tenantId ?? null,
        userId: options.userId ?? null,
        correlationId: options.correlationId ?? undefined,
        client: 'worker',
      });
      return this.store.run(synthetic, () => this.withTenantTx(options, fn));
    }

    if (this.store.transactionDepth() > 0) throw new NestedTransaction();

    const ctx = this.store.tryGet();
    const tenantId = options.tenantId ?? ctx?.tenant_id ?? null;
    const userId = options.userId ?? ctx?.user_id ?? null;
    const correlationId = options.correlationId ?? ctx?.correlation_id ?? null;
    const timeouts = TIMEOUTS[options.profile ?? 'interactive'];

    const client = await this.#pool.connect();
    this.store.enterTransaction();
    try {
      await client.query('BEGIN');

      // PgBouncer-safe: transaction-local settings only (K04-T01, K04-T09).
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId ?? '']);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId ?? '']);
      await client.query(`SELECT set_config('app.correlation_id', $1, true)`, [correlationId ?? '']);

      // K04-T08: timeouts for this transaction only.
      await client.query(`SET LOCAL statement_timeout = ${Number(timeouts.statementTimeoutMs)}`);
      await client.query(`SET LOCAL lock_timeout = ${Number(timeouts.lockTimeoutMs)}`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${Number(timeouts.idleInTransactionMs)}`,
      );

      const result = await fn(makeExecutor(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      this.store.exitTransaction();
      client.release();
    }
  }

  /**
   * P-05 guard for external calls (K04-T04 / K04-T05).
   * Call this from injected fetch/module-facade/mail wrappers before acting.
   */
  assertOutsideTransaction(operation: string): void {
    if (this.store.transactionDepth() === 0) return;
    if ((this.p05.mode ?? 'development') === 'production') {
      this.violationCount += 1;
      this.p05.onViolation?.(operation);
      return;
    }
    throw new TxBoundaryViolation(operation);
  }
}
