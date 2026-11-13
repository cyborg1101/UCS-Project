/**
 * Migration runner (K-02).
 *
 * Two phases, matching the privilege model:
 *   1. cluster scripts (db/migrations/cluster/*.sql) run as the admin/superuser:
 *      they create roles, the database, and revoke PUBLIC privileges.
 *   2. database scripts (db/migrations/*.sql) run as `migrator`, tracked in
 *      public.schema_migrations, each in its own transaction.
 *
 * Flags:
 *   --bootstrap-only   only run phase 1
 *   --template         also (re)build the `ucs_template` database used by tests
 *   --reset            drop the application database first
 */
import { Client } from 'pg';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
const DB_NAME = process.env.PGDATABASE ?? 'ucs';
const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '5432';
const MIGRATOR_URL = process.env.DATABASE_URL ?? `postgres://migrator@${HOST}:${PORT}/${DB_NAME}`;
const TEMPLATE_DB = 'ucs_template';

function log(msg: string): void {
  console.log(`[migrate] ${msg}`);
}

function sqlFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(abs, f));
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runClusterPhase(): Promise<void> {
  await withClient(ADMIN_URL, async (admin) => {
    for (const file of sqlFiles('db/migrations/cluster')) {
      log(`cluster: ${file.split('/').pop()}`);
      await admin.query(readFileSync(file, 'utf8'));
    }

    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (exists.rowCount === 0) {
      log(`creating database ${DB_NAME}`);
      await admin.query(`CREATE DATABASE ${quoteIdent(DB_NAME)}`);
    }
    await admin.query(`ALTER DATABASE ${quoteIdent(DB_NAME)} OWNER TO migrator`);
  });
}

async function runDatabasePhase(): Promise<void> {
  await withClient(MIGRATOR_URL, async (db) => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL
      )
    `);

    const applied = new Set(
      (await db.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );

    for (const file of sqlFiles('db/migrations')) {
      const version = file.split('/').pop()!;
      const sql = readFileSync(file, 'utf8');
      if (applied.has(version)) {
        log(`skip (applied): ${version}`);
        continue;
      }
      log(`apply: ${version}`);
      await db.query('BEGIN');
      try {
        await db.query(sql);
        await db.query(
          'INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, md5($2))',
          [version, sql],
        );
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(err as Error).message}`);
      }
    }
  });
}

/**
 * Superuser phase. Event triggers and extensions that must not be reachable by
 * the migration role live here. Applied against the app database, tracked in
 * public.schema_migrations with a `su:` prefix so ordering stays auditable.
 */
async function runSuperuserPhase(): Promise<void> {
  const files = sqlFiles('db/migrations/superuser');
  if (files.length === 0) return;

  const adminUrl = new URL(ADMIN_URL);
  adminUrl.pathname = `/${DB_NAME}`;

  await withClient(adminUrl.toString(), async (db) => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL
      )
    `);
    const applied = new Set(
      (await db.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );

    for (const file of files) {
      const version = `su:${file.split('/').pop()!}`;
      if (applied.has(version)) {
        log(`skip (applied): ${version}`);
        continue;
      }
      log(`apply (superuser): ${version}`);
      const sql = readFileSync(file, 'utf8');
      await db.query('BEGIN');
      try {
        await db.query(sql);
        await db.query(
          'INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, md5($2))',
          [version, sql],
        );
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw new Error(`superuser migration ${version} failed: ${(err as Error).message}`);
      }
    }
  });
}

async function rebuildTemplate(): Promise<void> {
  await withClient(ADMIN_URL, async (admin) => {
    // Terminate lingering sessions so DROP DATABASE can proceed.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEMPLATE_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DB)}`);
    log(`building template ${TEMPLATE_DB} from ${DB_NAME}`);
    await admin.query(
      `CREATE DATABASE ${quoteIdent(TEMPLATE_DB)} OWNER migrator TEMPLATE ${quoteIdent(DB_NAME)}`,
    );
  });
}

async function resetDatabase(): Promise<void> {
  await withClient(ADMIN_URL, async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(DB_NAME)}`);
    log(`dropped ${DB_NAME}`);
  });
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--reset')) await resetDatabase();
  await runClusterPhase();
  if (args.has('--bootstrap-only')) {
    log('bootstrap only: done');
    return;
  }
  await runDatabasePhase();
  await runSuperuserPhase();
  if (args.has('--template')) await rebuildTemplate();
  log('done');
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err.message);
  process.exit(1);
});
