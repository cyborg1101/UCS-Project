/**
 * K-07 — Audit log: append-in-transaction, hash chain, append-only guards.
 * Integration tests against real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  connectAs,
  createTestDatabase,
  expectFailure,

  TENANT_A,
  TENANT_B,
} from '../../tools/db/test-db';
import { randomUUID } from 'node:crypto';

let db: { name: string; drop: () => Promise<void> };
let app: Client;
let admin: Client;

beforeAll(async () => {
  db = await createTestDatabase('ucs_k07');
  app = await connectAs('app_sample', db.name);
  admin = await connectAs('migrator', db.name);
}, 120_000);

afterAll(async () => {
  await admin?.end().catch(() => undefined);
  await app?.end().catch(() => undefined);
  await db?.drop();
});

describe('[K07-T01] audit.append يكتب في معاملة العمل نفسها', () => {
  it('rolls the audit entry back with the business transaction', async () => {
    const before = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE tenant_id = $1`,
      [TENANT_A],
    );

    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await app.query(`SELECT audit.append('TEST.ROLLBACK')`);
    await app.query('ROLLBACK');

    const after = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });

  it('commits the audit entry with the business transaction', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await app.query(`SELECT set_config('app.user_id', $1, true)`, [
      '00000000-0000-7000-8000-0000000000c1',
    ]);
    await app.query(`SELECT audit.append('TEST.COMMIT', 'sample.item', $1, 'test', $2::jsonb)`, [
      randomUUID(),
      JSON.stringify({ ok: true }),
    ]);
    await app.query('COMMIT');
  });
});

describe('[K07-T02] القيد يحمل الحقول من السياق دون تمرير يدوي', () => {
  it('records tenant, actor, correlation and action from the context', async () => {
    const correlationId = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    await app.query(`SELECT set_config('app.user_id', $1, true)`, ['']);
    await app.query(`SELECT set_config('app.correlation_id', $1, true)`, [correlationId]);
    await app.query(`SELECT audit.append('TEST.CONTEXT', 'sample.item', NULL, 'purpose-x')`);
    await app.query('COMMIT');

    const row = await admin.query(
      `SELECT tenant_id, action, correlation_id, purpose, actor_id FROM audit.audit_entry
        WHERE tenant_id = $1 AND action = 'TEST.CONTEXT' ORDER BY seq DESC LIMIT 1`,
      [TENANT_B],
    );
    expect(row.rows[0]).toMatchObject({
      tenant_id: TENANT_B,
      action: 'TEST.CONTEXT',
      correlation_id: correlationId,
      purpose: 'purpose-x',
      actor_id: null,
    });
  });
});

describe('[K07-T03/T04] منع UPDATE وDELETE وTRUNCATE', () => {
  it('rejects UPDATE for the app role', async () => {
    const err = await expectFailure(app, `UPDATE audit.audit_entry SET action = 'HACKED'`);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/permission denied|append-only/i);
  });

  it('rejects DELETE for the app role', async () => {
    const err = await expectFailure(app, `DELETE FROM audit.audit_entry`);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/permission denied|append-only/i);
  });

  it('rejects TRUNCATE even as the superuser', async () => {
    const admin = await connectAs('migrator', db.name);
    try {
      await admin.query(`GRANT ALL ON audit.audit_entry TO migrator`).catch(() => undefined);
      const err = await expectFailure(admin, `TRUNCATE audit.audit_entry`);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/append-only|permission denied/i);
    } finally {
      await admin.end();
    }
  });

  it('rejects UPDATE even for the table owner', async () => {
    const admin = await connectAs('migrator', db.name);
    try {
      const err = await expectFailure(admin, `UPDATE audit.audit_entry SET action = 'HACKED'`);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/append-only/i);
    } finally {
      await admin.end();
    }
  });
});

describe('[K07-T05] app_sample ينفّذ append فقط ولا يقرأ الجدول', () => {
  it('cannot SELECT the audit table directly', async () => {
    // The RLS policy allows tenant reads, but GRANT SELECT is not issued to
    // app_sample at all, so the failure is a privilege error.
    const err = await expectFailure(app, `SELECT * FROM audit.audit_entry`);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/permission denied/i);
  });

  it('can execute audit.append', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const r = await app.query(`SELECT audit.append('TEST.APPEND_OK') AS seq`);
    await app.query('COMMIT');
    expect(Number(r.rows[0]!.seq)).toBeGreaterThan(0);
  });
});

describe('[K07-T06..T11] سلسلة التجزئة', () => {
  let chainer: Client;

  beforeAll(async () => {
    chainer = await connectAs('app_audit_chainer', db.name);
    // Seal everything that the earlier tests appended.
    await chainer.query(`SELECT audit.chain_pending($1)`, [TENANT_A]);
    await chainer.query(`SELECT audit.chain_pending($1)`, [TENANT_B]);
  });

  afterAll(async () => {
    await chainer?.end().catch(() => undefined);
  });

  it('fills chain_pos, prev_hash and entry_hash (K07-T06)', async () => {
    const rows = await admin.query(
      `SELECT chain_pos, prev_hash, entry_hash FROM audit.audit_entry
        WHERE tenant_id = $1 AND chain_pos IS NOT NULL ORDER BY chain_pos`,
      [TENANT_A],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(Number(r.chain_pos)).toBeGreaterThan(0);
      expect(r.entry_hash).not.toBeNull();
    }
    // chain_pos is dense: 1..N with no gaps.
    const positions = rows.rows.map((r: { chain_pos: string }) => Number(r.chain_pos));
    expect(positions).toEqual(positions.map((_, i) => i + 1));
  });

  it('keeps an independent chain per tenant (K07-T07)', async () => {
    const a = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE tenant_id = $1 AND chain_pos = 1`,
      [TENANT_A],
    );
    const b = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE tenant_id = $1 AND chain_pos = 1`,
      [TENANT_B],
    );
    expect(a.rows[0]!.c).toBe(1);
    expect(b.rows[0]!.c).toBe(1);
  });

  it('re-running chain_pending is a no-op and safe concurrently (K07-T08)', async () => {
    const before = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE tenant_id = $1 AND chain_pos IS NULL`,
      [TENANT_A],
    );
    const [r1, r2] = await Promise.all([
      chainer.query<{ audit: number }>(`SELECT audit.chain_pending($1) AS audit`, [TENANT_A]),
      chainer.query<{ audit: number }>(`SELECT audit.chain_pending($1) AS audit`, [TENANT_A]),
    ]);
    const after = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE tenant_id = $1 AND chain_pos IS NULL`,
      [TENANT_A],
    );
    expect(after.rows[0]!.c).toBe(0);
    // Whatever the split, both runs together sealed exactly the pending rows.
    const sealed = Number(r1.rows[0]!.audit) + Number(r2.rows[0]!.audit);
    expect(sealed).toBe(before.rows[0]!.c);
  });

  it('verify_chain returns OK for a healthy chain (K07-T09)', async () => {
    const r = await chainer.query<{ verify_chain: string }>(
      `SELECT audit.verify_chain($1) AS verify_chain`,
      [TENANT_A],
    );
    expect(r.rows[0]!.verify_chain).toBe('OK');
  });

  it('detects a tampered row and reports the first break (K07-T10)', async () => {
    // The mutation trigger blocks honest roles, so simulate a breach: disable
    // the trigger as superuser, alter one row, re-enable, then verify.
    const admin = await connectAs('migrator', db.name);
    try {
      await admin.query(`ALTER TABLE audit.audit_entry DISABLE TRIGGER audit_entry_immutable`);
      await admin.query(
        `UPDATE audit.audit_entry SET action = 'TAMPERED'
          WHERE tenant_id = $1 AND chain_pos = 2`,
        [TENANT_A],
      );
      await admin.query(`ALTER TABLE audit.audit_entry ENABLE TRIGGER audit_entry_immutable`);

      const r = await chainer.query<{ verify_chain: string }>(
        `SELECT audit.verify_chain($1) AS verify_chain`,
        [TENANT_A],
      );
      expect(r.rows[0]!.verify_chain).toBe('BROKEN:2');
    } finally {
      await admin.end();
    }
  });

  it('canonical() is key-order independent (K07-T11)', async () => {
    const r = await chainer.query<{ same: boolean }>(
      `SELECT audit.canonical('{"a":1,"b":2}'::jsonb) = audit.canonical('{"b":2,"a":1}'::jsonb) AS same`,
    );
    expect(r.rows[0]!.same).toBe(true);
  });
});

describe('[K07-T12] التقسيم الشهري', () => {
  it('creates a partition for any month it receives a row in', async () => {
    const admin = await connectAs('migrator', db.name);
    try {
      const future = new Date();
      future.setUTCMonth(future.getUTCMonth() + 5);
      const monthName = `audit_entry_${future.toISOString().slice(0, 7).replace('-', '')}`;

      // The helper must create the missing month rather than fail (K07-T12).
      await admin.query(`SELECT audit.ensure_month_partition($1)`, [future.toISOString()]);

      // And a row dated into that month must then insert cleanly.
      await admin.query(
        `INSERT INTO audit.audit_entry (occurred_at, tenant_id, action)
         VALUES ($1, $2, 'TEST.FUTURE_PARTITION')`,
        [future.toISOString(), TENANT_A],
      );

      const part = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_class c
           JOIN pg_namespace n2 ON n2.oid = c.relnamespace
          WHERE n2.nspname = 'audit' AND c.relname = $1`,
        [monthName],
      );
      expect(part.rows[0]!.n).toBe('1');
    } finally {
      await admin.end();
    }
  });

  it('ensure_month_partition is idempotent', async () => {
    const admin = await connectAs('migrator', db.name);
    try {
      await admin.query(`SELECT audit.ensure_month_partition(now())`);
      await admin.query(`SELECT audit.ensure_month_partition(now())`);
    } finally {
      await admin.end();
    }
  });
});
