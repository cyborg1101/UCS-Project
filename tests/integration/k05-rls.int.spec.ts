/**
 * K-05 — Tenant isolation (row level security) and the AC-039 boundary.
 *
 * Tests run as the *real* application role against real PostgreSQL. A passing
 * suite here is the phase acceptance gate: if these fail, nothing built later
 * can be trusted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  connectAs,
  createTestDatabase,
  expectFailure,
  inTenantTx,
  TENANT_A,
  TENANT_B,
} from '../../tools/db/test-db';
import { randomUUID } from 'node:crypto';
import { findRlsViolations } from '../../tools/ci/check-rls';
import { findIndexViolations } from '../../tools/ci/check-indexes';

let db: { name: string; drop: () => Promise<void> };
let app: Client;

const ITEM_A = randomUUID();
const ITEM_B = randomUUID();

beforeAll(async () => {
  db = await createTestDatabase('ucs_k05');
  app = await connectAs('app_sample', db.name);

  // Seed one item per tenant, each through a correctly scoped transaction.
  await inTenantTx(app, { tenantId: TENANT_A }, async () => {
    await app.query(
      `INSERT INTO sample.item (id, tenant_id, public_id, name, seq) VALUES ($1,$2,'A1','item A',1)`,
      [ITEM_A, TENANT_A],
    );
  });
  await inTenantTx(app, { tenantId: TENANT_B }, async () => {
    await app.query(
      `INSERT INTO sample.item (id, tenant_id, public_id, name, seq) VALUES ($1,$2,'B1','item B',1)`,
      [ITEM_B, TENANT_B],
    );
  });
}, 120_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await db?.drop();
});

describe('[K05-T01] بدون app.tenant_id لا صفوف ولا خطأ', () => {
  it('returns zero rows, not all rows and not an error', async () => {
    const r = await app.query('SELECT * FROM sample.item');
    expect(r.rows).toHaveLength(0);
  });
});

describe('[K05-T02] قيمة نصية فارغة تعيد صفراً بلا خطأ cast', () => {
  it('treats empty string as no tenant thanks to NULLIF', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', '', true)`);
    const r = await app.query('SELECT * FROM sample.item');
    await app.query('COMMIT');
    expect(r.rows).toHaveLength(0);
  });
});

describe('[K05-T03] مستأجر A يرى صفوفه فقط', () => {
  it('sees exactly its own row', async () => {
    await inTenantTx(app, { tenantId: TENANT_A }, async () => {
      const r = await app.query<{ id: string }>('SELECT id FROM sample.item');
      expect(r.rows.map((x) => x.id)).toEqual([ITEM_A]);
    });
  });

  it('cannot see tenant B by id', async () => {
    await inTenantTx(app, { tenantId: TENANT_A }, async () => {
      const r = await app.query('SELECT id FROM sample.item WHERE id = $1', [ITEM_B]);
      expect(r.rows).toHaveLength(0);
    });
  });
});

describe('[K05-T04] INSERT بمعرّف مستأجر آخر مرفوض (WITH CHECK)', () => {
  it('refuses to write a row belonging to tenant B from tenant A', async () => {
    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () => {
        await app.query(
          `INSERT INTO sample.item (id, tenant_id, public_id, name, seq) VALUES ($1,$2,'X','x',9)`,
          [randomUUID(), TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('[K05-T05] UPDATE/DELETE على صف مستأجر آخر لا يمس شيئاً', () => {
  it('updates zero rows', async () => {
    await inTenantTx(app, { tenantId: TENANT_A }, async () => {
      const r = await app.query('UPDATE sample.item SET name = $1 WHERE id = $2', ['hacked', ITEM_B]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('deletes zero rows', async () => {
    await inTenantTx(app, { tenantId: TENANT_A }, async () => {
      const r = await app.query('DELETE FROM sample.item WHERE id = $1', [ITEM_B]);
      expect(r.rowCount).toBe(0);
    });
    // B's row is intact.
    await inTenantTx(app, { tenantId: TENANT_B }, async () => {
      const r = await app.query<{ name: string }>('SELECT name FROM sample.item WHERE id = $1', [ITEM_B]);
      expect(r.rows[0]!.name).toBe('item B');
    });
  });
});

describe('[K05-T06] نقل صف إلى مستأجر آخر مرفوض', () => {
  it('rejects UPDATE ... SET tenant_id = B on a row owned by A', async () => {
    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () => {
        await app.query('UPDATE sample.item SET tenant_id = $1 WHERE id = $2', [TENANT_B, ITEM_A]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('[K05-T07] FORCE RLS يُخضع المالك للسياسة', () => {
  it('binding the table owner still filters rows by app.tenant_id', async () => {
    // migrator is a member of owner_sample, so SET ROLE reaches the owner role.
    // Without FORCE RLS an owner would bypass the policy entirely.
    const owner = await connectAs('migrator', db.name);
    try {
      await owner.query('BEGIN');
      await owner.query('SET LOCAL ROLE owner_sample');
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const r = await owner.query<{ id: string }>('SELECT id FROM sample.item');
      await owner.query('ROLLBACK');
      expect(r.rows.map((x) => x.id)).toEqual([ITEM_A]);
    } finally {
      await owner.end();
    }
  });

  it('owner sees nothing with no tenant set', async () => {
    const owner = await connectAs('migrator', db.name);
    try {
      await owner.query('BEGIN');
      await owner.query('SET LOCAL ROLE owner_sample');
      const r = await owner.query('SELECT id FROM sample.item');
      await owner.query('ROLLBACK');
      expect(r.rows).toHaveLength(0);
    } finally {
      await owner.end();
    }
  });
});

describe('[K05-T08] فحص آلي: كل جدول وحدة عليه ENABLE+FORCE+سياسة', () => {
  it('passes on the migrated schema', async () => {
    expect(await findRlsViolations(app, ['sample'])).toEqual([]);
  });

  it('fails when a table is created without RLS', async () => {
    const owner = await connectAs('migrator', db.name);
    try {
      await owner.query(`CREATE TABLE sample.leaky (id int, tenant_id uuid)`);
      const findings = await findRlsViolations(app, ['sample']);
      expect(findings.some((f) => f.table === 'leaky')).toBe(true);
      expect(findings.find((f) => f.table === 'leaky')!.problem).toMatch(/not enabled/i);
    } finally {
      await owner.query(`DROP TABLE IF EXISTS sample.leaky`).catch(() => undefined);
      await owner.end();
    }
  });

  it('fails when a table has RLS enabled but not forced', async () => {
    const owner = await connectAs('migrator', db.name);
    try {
      await owner.query(`CREATE TABLE sample.half (id int, tenant_id uuid)`);
      await owner.query(`ALTER TABLE sample.half ENABLE ROW LEVEL SECURITY`);
      await owner.query(
        `CREATE POLICY p ON sample.half USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
      );
      const findings = await findRlsViolations(app, ['sample']);
      expect(findings.find((f) => f.table === 'half')!.problem).toMatch(/not FORCED/i);
    } finally {
      await owner.query(`DROP TABLE IF EXISTS sample.half`).catch(() => undefined);
      await owner.end();
    }
  });
});

describe('[K05-T09] فحص آلي: الفهارس تبدأ بـtenant_id', () => {
  it('passes on the migrated schema', async () => {
    expect(await findIndexViolations(app, ['sample'])).toEqual([]);
  });

  it('fails when a secondary index skips tenant_id', async () => {
    const owner = await connectAs('migrator', db.name);
    try {
      await owner.query(`CREATE INDEX item_name_only_idx ON sample.item (name)`);
      const findings = await findIndexViolations(app, ['sample']);
      expect(findings.some((f) => f.index === 'item_name_only_idx')).toBe(true);
    } finally {
      await owner.query(`DROP INDEX IF EXISTS sample.item_name_only_idx`).catch(() => undefined);
      await owner.end();
    }
  });
});

describe('[K05-T12] قراءة أدلة الحسابات مغلقة على app_*', () => {
  it('app_sample cannot read the future identity schema', async () => {
    // Regression guard: identity.account_directory arrives in Phase 1 and must
    // stay closed to module roles. Proven here on the schema itself.
    const err = await expectFailure(app, 'SELECT * FROM identity.account_directory');
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/permission denied|does not exist/i);
  });
});
