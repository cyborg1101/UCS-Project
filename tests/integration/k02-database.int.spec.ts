/**
 * K-02 — Database roles, migration, and privilege checks.
 * Integration tests against a real PostgreSQL cluster (no mocks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  adminQuery,
  connectAs,
  queryInDatabase,
  createTestDatabase,
  expectFailure,
  inTenantTx,
  TENANT_A,
  TEMPLATE_DB,
} from '../../tools/db/test-db';
import { randomUUID } from 'node:crypto';

let db: { name: string; drop: () => Promise<void> };
let app: Client;

beforeAll(async () => {
  db = await createTestDatabase('ucs_k02');
  app = await connectAs('app_sample', db.name);
}, 120_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await db?.drop();
});

describe('[K02-T01] الأدوار تُنشأ بعد الترحيلات', () => {
  it('creates every required role', async () => {
    const rows = await adminQuery<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [['owner_sample', 'app_sample', 'app_relay', 'app_audit_chainer', 'reporting_reader', 'migrator']],
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      'app_audit_chainer',
      'app_relay',
      'app_sample',
      'migrator',
      'owner_sample',
      'reporting_reader',
    ]);
  });
});

describe('[K02-T02] سمات الأدوار', () => {
  it('owner_* roles are NOLOGIN; no app role is SUPERUSER or BYPASSRLS', async () => {
    const rows = await adminQuery<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles
         WHERE rolname LIKE 'owner_%' OR rolname LIKE 'app_%' OR rolname = 'reporting_reader'`);

    const owners = rows.filter((r) => r.rolname.startsWith('owner_'));
    expect(owners.length).toBeGreaterThan(0);
    for (const o of owners) expect(o.rolcanlogin).toBe(false);

    for (const r of rows.filter((x) => x.rolname.startsWith('app_'))) {
      expect(r.rolsuper).toBe(false);
      expect(r.rolbypassrls).toBe(false);
    }
  });
});

describe('[K02-T03] PUBLIC لا يملك USAGE ولا CONNECT', () => {
  it('revokes schema usage and database connect from PUBLIC', async () => {
    // Must run inside the cloned database: current_database() and the schema
    // catalog are per-database, so a query via the maintenance DB proves nothing.
    const [row] = await queryInDatabase<{ pub_connect: boolean; pub_usage: number }>(
      db.name,
      `SELECT has_database_privilege('public', current_database(), 'CONNECT') AS pub_connect,
              (SELECT count(*)::int FROM pg_namespace n
                WHERE n.nspname IN ('sample','audit','messaging','kernel','platform')
                  AND has_schema_privilege('public', n.oid, 'USAGE')) AS pub_usage`,
    );
    expect(row.pub_connect).toBe(false);
    expect(row.pub_usage).toBe(0);
  });
});

describe('[K02-T04] حدود app_sample', () => {
  it('reads and writes sample.*', async () => {
    await inTenantTx(app, { tenantId: TENANT_A }, async () => {
      await app.query(
        `INSERT INTO sample.item (id, tenant_id, public_id, name, seq) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), TENANT_A, 'A1', 'item', 1],
      );
      const r = await app.query('SELECT count(*)::int AS c FROM sample.item');
      expect(r.rows[0].c).toBe(1);
    });
  });

  it('is denied on audit.audit_entry and messaging.event_log', async () => {
    const auditErr = await expectFailure(app, 'SELECT * FROM audit.audit_entry');
    expect(auditErr).not.toBeNull();
    expect(auditErr!.message).toMatch(/permission denied|does not exist/i);

    const msgErr = await expectFailure(app, 'SELECT * FROM messaging.event_log');
    expect(msgErr).not.toBeNull();
    expect(msgErr!.message).toMatch(/permission denied|does not exist/i);
  });

  it('is denied on another module schema', async () => {
    const err = await expectFailure(app, 'CREATE TABLE sample2.probe (x int)');
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/permission denied|does not exist/i);
  });
});

describe('[K02-T05] CONNECTION LIMIT وفق جدول Pools', () => {
  it('enforces the SAD §10.4 pool sizes', async () => {
    const rows = await adminQuery<{ rolname: string; rolconnlimit: number }>(
      `SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [['app_sample', 'app_relay', 'app_audit_chainer', 'reporting_reader']],
    );
    const limits = Object.fromEntries(rows.map((r) => [r.rolname, r.rolconnlimit]));
    expect(limits.app_sample).toBe(3);
    expect(limits.app_relay).toBe(1);
    expect(limits.app_audit_chainer).toBe(1);
    expect(limits.reporting_reader).toBe(4);
  });
});

describe('[K02-T06] الترحيل قابل لإعادة التشغيل', () => {
  it('records each migration exactly once', async () => {
    const rows = await queryInDatabase<{ version: string; n: string }>(
      db.name,
      `SELECT version, count(*)::text AS n FROM public.schema_migrations GROUP BY version`,
    );
    for (const r of rows) expect(r.n).toBe('1');
  });
});

describe('[K02-T07] استنساخ قاعدة الاختبار سريع', () => {
  it('clones the template in under two seconds', async () => {
    const started = Date.now();
    const clone = await createTestDatabase('ucs_perf');
    const elapsed = Date.now() - started;
    await clone.drop();
    expect(elapsed).toBeLessThan(2000);
  }, 30_000);

  it('template carries the full migrated schema', async () => {
    const rows = await queryInDatabase<{ n: string }>(
      db.name,
      `SELECT count(*)::text AS n FROM public.schema_migrations`,
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(3);
    expect(TEMPLATE_DB).toBe('ucs_template');
  });
});
