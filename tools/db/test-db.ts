/**
 * Integration-test database harness (SAD Phase0 §2.4).
 *
 * Roles live at cluster level (created once by the cluster migration).
 * Each test file clones a private database from `ucs_template` in a few
 * hundred milliseconds, connects as the *real application role*, and drops
 * it afterwards. No database mocks: the guarantees live inside PostgreSQL.
 */
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { buildContext, contextStore, type Executor } from '@ucs/kernel';

export const HOST = process.env.PGHOST ?? '127.0.0.1';
export const PORT = process.env.PGPORT ?? '5432';
export const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? `postgres://postgres@${HOST}:${PORT}/postgres`;
export const TEMPLATE_DB = process.env.TEST_TEMPLATE_DB ?? 'ucs_template';

export const TENANT_A = '00000000-0000-7000-8000-0000000000aa';
export const TENANT_B = '00000000-0000-7000-8000-0000000000bb';
export const TENANT_CODE_A = 'AA';
export const TENANT_CODE_B = 'BB';

export function urlFor(role: string, database: string): string {
  return `postgres://${role}@${HOST}:${PORT}/${database}`;
}

export async function adminQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows as T[];
  } finally {
    await c.end();
  }
}

/** Like adminQuery, but scoped to a specific database (catalog queries must be). */
export async function queryInDatabase<T = unknown>(
  database: string,
  sql: string,
  params: unknown[] = [],
  role = 'migrator',
): Promise<T[]> {
  const c = new Client({ connectionString: urlFor(role, database) });
  await c.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows as T[];
  } finally {
    await c.end();
  }
}

export async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/**
 * Clone the template into a throwaway database for this test file.
 * Returns the database name plus a disposer.
 */
export async function createTestDatabase(
  prefix = 'ucs_t',
): Promise<{ name: string; drop: () => Promise<void> }> {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  await adminExec(`CREATE DATABASE "${name}" OWNER migrator TEMPLATE "${TEMPLATE_DB}"`);
  // CREATE DATABASE resets the database ACL (datacl is not copied from the
  // template), so provisioning parity with 0002_platform_schemas must be
  // re-applied here: PUBLIC keeps no CONNECT.
  await adminExec(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
  await adminExec(
    `GRANT CONNECT ON DATABASE "${name}" TO migrator, app_sample, app_relay, app_audit_chainer, reporting_reader`,
  );
  return {
    name,
    drop: async () => {
      await adminQuery(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
      await adminExec(`DROP DATABASE IF EXISTS "${name}"`);
    },
  };
}

export async function connectAs(role: string, database: string): Promise<Client> {
  const client = new Client({ connectionString: urlFor(role, database) });
  await client.connect();
  return client;
}

/** Run a statement and return error (null when it succeeded). */
export async function expectFailure(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<Error | null> {
  try {
    await client.query(sql, params);
    return null;
  } catch (err) {
    return err as Error;
  }
}

export interface TxOptions {
  tenantId?: string | null;
  userId?: string | null;
  correlationId?: string;
  statementTimeoutMs?: number;
}

/**
 * Minimal withTenantTx for raw integration tests: mirrors the production
 * implementation in libs/kernel/db (SET LOCAL only, never session SET).
 *
 * It also binds the request context in AsyncLocalStorage, exactly as the real
 * HTTP/worker entry points do. Without it, code that legitimately reads the
 * context (outbox correlation ids, audit actor, P-05 transaction marker) would
 * behave differently under test than in production — the harness must not
 * change the semantics it is meant to verify.
 */
export async function inTenantTx<T>(
  client: Client,
  opts: TxOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (contextStore.tryGet()) {
    return runInTx(client, opts, fn);
  }
  const ctx = buildContext({
    tenantId: opts.tenantId ?? null,
    userId: opts.userId ?? null,
    correlationId: opts.correlationId ?? undefined,
    client: 'test',
  });
  return contextStore.run(ctx, () => runInTx(client, opts, fn));
}

async function runInTx<T>(client: Client, opts: TxOptions, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [opts.tenantId ?? '']);
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [opts.userId ?? '']);
    await client.query(`SELECT set_config('app.correlation_id', $1, true)`, [
      opts.correlationId ?? '',
    ]);
    if (opts.statementTimeoutMs) {
      await client.query(`SET LOCAL statement_timeout = ${Number(opts.statementTimeoutMs)}`);
    }
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/**
 * Real `Executor` over a live client — the same three-method surface the kernel
 * hands to module code, so tests exercise the production contract rather than a
 * hand-rolled stub that can silently diverge from it.
 */
export function executorFor(client: Client): Executor {
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

/**
 * Connection limits are cluster-wide (`pg_roles.rolconnlimit`), so a test that
 * must prove two *simultaneous* writers are mutually excluded - or that needs
 * more sessions than the production pool allows - raises the ceiling for the
 * duration of that one probe. Production keeps the SAD §10.4 value, and the
 * limit is restored even when the assertion throws.
 */
export async function withRoleConnectionLimit<T>(
  role: string,
  limit: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = await adminQuery<{ rolconnlimit: number }>(
    `SELECT rolconnlimit FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  await adminExec(`ALTER ROLE ${role} CONNECTION LIMIT ${Number(limit)}`);
  try {
    return await fn();
  } finally {
    await adminExec(
      `ALTER ROLE ${role} CONNECTION LIMIT ${Number(previous[0]!.rolconnlimit)}`,
    );
  }
}

export function withRelayConnectionLimit<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  return withRoleConnectionLimit('app_relay', limit, fn);
}
