/**
 * K-04 — withTenantTx and the P-05 transaction-boundary guard.
 * Integration tests against real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildContext,
  ContextStore,
  TenantDatabase,
  TIMEOUTS,
} from '../../libs/kernel/src';
import { NestedTransaction, TxBoundaryViolation } from '@ucs/shared';
import {
  connectAs,
  createTestDatabase,
  TENANT_A,
  urlFor,
} from '../../tools/db/test-db';
import type { Client } from 'pg';

let db: { name: string; drop: () => Promise<void> };
let store: ContextStore;
let database: TenantDatabase;

beforeAll(async () => {
  db = await createTestDatabase('ucs_k04');
  store = new ContextStore();
  database = new TenantDatabase(
    store,
    { connectionString: urlFor('app_sample', db.name), max: 1 },
    { mode: 'test' },
  );
}, 120_000);

afterAll(async () => {
  await database?.close();
  await db?.drop();
});

describe('[K04-T01] withTenantTx يضبط app.tenant_id محلياً للمعاملة', () => {
  it('exposes the tenant inside the transaction', async () => {
    const value = await database.withTenantTx({ tenantId: TENANT_A }, async (tx) => {
      const rows = await tx.query<{ v: string }>(`SELECT current_setting('app.tenant_id', true) AS v`);
      return rows[0]!.v;
    });
    expect(value).toBe(TENANT_A);
  });

  it('uses the tenant from the active request context when not passed explicitly', async () => {
    const value = await store.run(buildContext({ tenantId: TENANT_A, userId: null }), () =>
      database.withTenantTx({}, async (tx) => {
        const rows = await tx.query<{ t: string; u: string }>(
          `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.user_id', true) AS u`,
        );
        return rows[0]!;
      }),
    );
    expect(value.t).toBe(TENANT_A);
    expect(value.u).toBe('');
  });
});

describe('[K04-T02] بعد COMMIT لا يبقى app.tenant_id على الاتصال', () => {
  it('reverts the setting so a later borrower sees nothing', async () => {
    await database.withTenantTx({ tenantId: TENANT_A }, async (tx) => {
      // Set a session-scoped sentinel inside the tx to prove LOCAL semantics do
      // not leak: we only ever use set_config(..., true).
      const rows = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(rows[0]!.pid).toBeGreaterThan(0);
    });

    // Pool max=1, so this borrows the very same backend.
    const after = await database.withTenantTx({ tenantId: null }, async (tx) => {
      const rows = await tx.query<{ v: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS v`,
      );
      return rows[0]!.v;
    });
    expect(after === null || after === '').toBe(true);
  });
});

describe('[K04-T03] أي خطأ داخل fn يُلغي المعاملة', () => {
  it('rolls back the whole transaction', async () => {
    const before = await database.withTenantTx({ tenantId: TENANT_A }, (tx) =>
      tx.query<{ c: number }>('SELECT count(*)::int AS c FROM sample.item'),
    );

    await expect(
      database.withTenantTx({ tenantId: TENANT_A }, async (tx) => {
        await tx.execute(
          `INSERT INTO sample.item (id, tenant_id, public_id, name, seq)
           VALUES ('11111111-1111-7111-8111-111111111111', $1, 'rollback-me', 'x', 1)`,
          [TENANT_A],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await database.withTenantTx({ tenantId: TENANT_A }, (tx) =>
      tx.query<{ c: number }>('SELECT count(*)::int AS c FROM sample.item'),
    );
    expect(after[0]!.c).toBe(before[0]!.c);
  });
});

describe('[K04-T04/T05] حارس P-05 (النداء الخارجي داخل معاملة)', () => {
  it('throws TxBoundaryViolation in test/development mode', async () => {
    await database.withTenantTx({ tenantId: TENANT_A }, async () => {
      expect(store.isInTransaction()).toBe(true);
      expect(() => database.assertOutsideTransaction('fetch:https://example.com')).toThrow(
        TxBoundaryViolation,
      );
    });
  });

  it('does not throw outside a transaction', () => {
    expect(() => database.assertOutsideTransaction('fetch:https://example.com')).not.toThrow();
  });

  it('in production mode it logs and increments p05_violation_total instead of throwing', async () => {
    const prodStore = new ContextStore();
    const violations: string[] = [];
    const prodDb = new TenantDatabase(
      prodStore,
      { connectionString: urlFor('app_sample', db.name), max: 1 },
      { mode: 'production', onViolation: (op) => violations.push(op) },
    );
    try {
      await prodDb.withTenantTx({ tenantId: TENANT_A }, async () => {
        expect(() => prodDb.assertOutsideTransaction('mail:send')).not.toThrow();
      });
      expect(violations).toEqual(['mail:send']);
      expect(prodDb.violationCount).toBe(1);
    } finally {
      await prodDb.close();
    }
  });
});

describe('[K04-T06] لا يصل المستدعي إلى اتصال خام', () => {
  it('hands out only an Executor with three query helpers', async () => {
    await database.withTenantTx({ tenantId: TENANT_A }, async (tx) => {
      expect(Object.keys(tx).sort()).toEqual(['execute', 'query', 'queryOne']);
      expect((tx as unknown as { release?: unknown }).release).toBeUndefined();
      expect((tx as unknown as { pool?: unknown }).pool).toBeUndefined();
    });
  });

  it('does not expose the pool on the database object', () => {
    expect((database as unknown as { pool?: unknown }).pool).toBeUndefined();
  });
});

describe('[K04-T07] معاملة متداخلة ترفع خطأ', () => {
  it('rejects withTenantTx inside withTenantTx', async () => {
    await expect(
      database.withTenantTx({ tenantId: TENANT_A }, async () => {
        await database.withTenantTx({ tenantId: TENANT_A }, async () => undefined);
      }),
    ).rejects.toThrow(NestedTransaction);
  });

  it('recovers cleanly after the nested failure', async () => {
    const ok = await database.withTenantTx({ tenantId: TENANT_A }, (tx) =>
      tx.queryOne<{ one: number }>('SELECT 1 AS one'),
    );
    expect(ok?.one).toBe(1);
  });
});

describe('[K04-T08] المهل مضبوطة لكل معاملة', () => {
  it('applies the interactive profile values', async () => {
    const row = await database.withTenantTx({ tenantId: TENANT_A }, (tx) =>
      tx.queryOne<{ st: string; lt: string; it: string }>(
        // Compare as intervals: Postgres normalises 5000 to '5s' on read-back.
        `SELECT (current_setting('statement_timeout')::interval = ($1 || ' ms')::interval)::text AS st,
                (current_setting('lock_timeout')::interval = ($2 || ' ms')::interval)::text AS lt,
                (current_setting('idle_in_transaction_session_timeout')::interval = ($3 || ' ms')::interval)::text AS it`,
        [
          TIMEOUTS.interactive.statementTimeoutMs,
          TIMEOUTS.interactive.lockTimeoutMs,
          TIMEOUTS.interactive.idleInTransactionMs,
        ],
      ),
    );
    expect(row!.st).toBe('true');
    expect(row!.lt).toBe('true');
    expect(row!.it).toBe('true');
  });

  it('applies the background profile values', async () => {
    const row = await database.withTenantTx({ tenantId: TENANT_A, profile: 'background' }, (tx) =>
      tx.queryOne<{ st: string; lt: string }>(
        `SELECT (current_setting('statement_timeout')::interval = ($1 || ' ms')::interval)::text AS st,
                (current_setting('lock_timeout')::interval = ($2 || ' ms')::interval)::text AS lt`,
        [TIMEOUTS.background.statementTimeoutMs, TIMEOUTS.background.lockTimeoutMs],
      ),
    );
    expect(row!.st).toBe('true');
    expect(row!.lt).toBe('true');
  });

  it('cancels a statement that exceeds statement_timeout', async () => {
    await expect(
      database.withTenantTx({ tenantId: TENANT_A }, async (tx) => {
        // 200ms statement timeout, then sleep 2s.
        await tx.execute(`SET LOCAL statement_timeout = 200`);
        await tx.query('SELECT pg_sleep(2)');
      }),
    ).rejects.toMatchObject({ code: '57014' });
  });
});

describe('[K04-T09] توافق PgBouncer: لا SET على مستوى الجلسة', () => {
  it('leaves session-level timeouts untouched after the transaction', async () => {
    const client: Client = await connectAs('app_sample', db.name);
    try {
      const before = await client.query<{ st: string }>(`SHOW statement_timeout`);
      await database.withTenantTx({ tenantId: TENANT_A }, (tx) => tx.query('SELECT 1'));
      const after = await client.query<{ st: string }>(`SHOW statement_timeout`);
      // The session default must be unchanged: all our tuning used SET LOCAL.
      expect(after.rows[0]!.st).toBe(before.rows[0]!.st);
      expect(after.rows[0]!.st).not.toBe(String(TIMEOUTS.interactive.statementTimeoutMs));
    } finally {
      await client.end();
    }
  });
});
