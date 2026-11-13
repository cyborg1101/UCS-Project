/**
 * K-09 — Consumers: Inbox, Offset, DLQ.
 *
 * The cases are G4, E-07, E-08, E-09, E-11 plus the backoff and operator
 * surfaces. Everything runs against real PostgreSQL as the real application
 * role: the guarantees are inside the database (inbox primary key, cursor
 * functions, advisory lock), so mocking would prove nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  adminExec,
  adminQuery,
  connectAs,
  createTestDatabase,
  inTenantTx,
  queryInDatabase,
  TENANT_A,
  TENANT_B,
  urlFor,
  withRoleConnectionLimit,
} from '../../tools/db/test-db';
import {
  Consumer,
  MAX_ATTEMPTS,
  backoffDelayMs,
  type ConsumedEvent,
} from '../../libs/platform/messaging/src/consumer';

let db: { name: string; drop: () => Promise<void> };
let app: Client;
/** Consumers created by the current test; closed before the next one runs. */
let consumers: Consumer[] = [];

/**
 * Each Consumer owns a pool of one connection, and the E-08 case needs two
 * replicas at once. app_sample's production ceiling is 3 (SAD §10.4), so the
 * suite raises it for its own duration and restores it afterwards — the limit
 * itself is asserted separately in the K-02 suite against the real value.
 */
let originalSampleLimit = 0;

beforeAll(async () => {
  db = await createTestDatabase('ucs_k09');
  app = await connectAs('app_sample', db.name);

  /**
   * Result table for handler effects. Created here rather than in the migration
   * because it stands in for any business table a real consumer would write: it
   * must have the same RLS shape, so the atomicity tests exercise the real
   * policy path and not a privileged shortcut.
   */
  await queryInDatabase(
    db.name,
    `CREATE TABLE sample.consumer_result (
       id         uuid PRIMARY KEY,
       tenant_id  uuid NOT NULL,
       consumer   text NOT NULL,
       event_id   uuid NOT NULL,
       seq        bigint,
       CONSTRAINT consumer_result_event_unique UNIQUE (consumer, event_id)
     )`,
  );
  await queryInDatabase(db.name, `ALTER TABLE sample.consumer_result ENABLE ROW LEVEL SECURITY`);
  await queryInDatabase(db.name, `ALTER TABLE sample.consumer_result FORCE ROW LEVEL SECURITY`);
  await queryInDatabase(
    db.name,
    `CREATE POLICY tenant_isolation ON sample.consumer_result
       USING  (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
  );
  await queryInDatabase(db.name, `ALTER TABLE sample.consumer_result OWNER TO owner_sample`);
  await queryInDatabase(db.name, `GRANT SELECT, INSERT ON sample.consumer_result TO app_sample`);

  const limits = await adminQuery<{ rolconnlimit: number }>(
    `SELECT rolconnlimit FROM pg_roles WHERE rolname = 'app_sample'`,
  );
  originalSampleLimit = limits[0]!.rolconnlimit;
  await adminExec(`ALTER ROLE app_sample CONNECTION LIMIT 24`);
}, 120_000);

afterEach(async () => {
  // Connections are a finite cluster resource: a test that leaves its consumers
  // open starves the next one, which surfaces as "too many connections" rather
  // than the failure under test.
  for (const c of consumers) await c.close().catch(() => undefined);
  consumers = [];
});

afterAll(async () => {
  for (const c of consumers) await c.close().catch(() => undefined);
  await app?.end().catch(() => undefined);
  await adminExec(`ALTER ROLE app_sample CONNECTION LIMIT ${Number(originalSampleLimit)}`);
  await db?.drop();
});

/** Drain the outbox into messaging.event_log with explicit control over seqs. */
async function publish(events: Array<Record<string, unknown>>): Promise<void> {
  const c = new Client({ connectionString: urlFor('app_relay', db.name) });
  await c.connect();
  try {
    const epoch = (
      await c.query<{ acquire_lease: string }>(
        `SELECT messaging.acquire_lease('k09-publisher', 60) AS acquire_lease`,
      )
    ).rows[0]!.acquire_lease;
    const payload = events.map((e) => ({
      event_id: randomUUID(),
      tenant_id: TENANT_A,
      producer: 'sample',
      event_type: 'sample.item_created',
      event_version: 1,
      aggregate_type: 'item',
      aggregate_seq: 1,
      payload: { itemId: randomUUID(), name: 'n', seq: 1 },
      occurred_at: new Date().toISOString(),
      ...e,
    }));
    await c.query(`SELECT messaging.relay_batch($1, $2::jsonb)`, [epoch, JSON.stringify(payload)]);
  } finally {
    await c.end();
  }
}

/** A consumer whose handler records every event it was given. */
function makeConsumer(
  name: string,
  seen: ConsumedEvent[],
  opts: { maxAttempts?: number; failOn?: (e: ConsumedEvent) => boolean } = {},
): Consumer {
  const consumer = new Consumer(
    {
      connectionString: urlFor('app_sample', db.name),
      name,
      schema: 'sample',
      subscriptions: ['sample.item_created'],
      batchSize: 100,
      ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    },
    async (event, tx) => {
      if (opts.failOn?.(event)) throw new Error('poison event');
      seen.push(event);
      await tx.execute(
        `INSERT INTO sample.consumer_result (id, tenant_id, consumer, event_id, seq)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), event.tenantId, name, event.eventId, event.aggregateSeq],
      );
    },
  );
  consumers.push(consumer);
  return consumer;
}

/**
 * Read the effect table the way a tenant would. consumer_result is FORCE-RLS
 * protected and its policy admits no operational role, so reading it as
 * migrator would silently return zero rows and make every assertion pass for
 * the wrong reason. Both seeded tenants are read and merged, because a consumer
 * legitimately processes events for more than one tenant.
 */
async function results(consumer: string): Promise<Array<{ seq: string }>> {
  const rows: Array<{ seq: string }> = [];
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const found = await inTenantTx(app, { tenantId }, async () =>
      app.query<{ seq: string }>(
        `SELECT coalesce(seq, 0)::text AS seq FROM sample.consumer_result
          WHERE consumer = $1 ORDER BY seq`,
        [consumer],
      ),
    );
    rows.push(...found.rows);
  }
  return rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

async function offsetOf(consumer: string): Promise<number> {
  const rows = await queryInDatabase<{ o: string }>(
    db.name,
    `SELECT sample.consumer_offset($1)::text AS o`,
    [consumer],
  );
  return Number(rows[0]!.o);
}

async function parkedRows(consumer: string): Promise<Array<{ aggregate_seq: string; expected_seq: string }>> {
  const rows = await app.query<{ aggregate_seq: string; expected_seq: string }>(
    `SELECT aggregate_seq::text, expected_seq::text FROM sample.parked_for_consumer($1) ORDER BY aggregate_seq`,
    [consumer],
  );
  return rows.rows;
}

/** Dead letters as the consumer's own operational view (K09-T09/T10/T11). */
async function deadLetters(consumer: string) {
  const rows = await app.query<{
    id: string;
    event_id: string;
    tenant_id: string;
    attempts: number;
    log_seq: string | null;
    skipped_reason: string | null;
  }>(`SELECT id, event_id, tenant_id, attempts, log_seq, skipped_reason FROM sample.consumer_dead_letters($1)`, [
    consumer,
  ]);
  return rows.rows;
}

/** Inbox rows for one consumer, counted through the operational door. */
async function inboxCount(consumer: string): Promise<number> {
  const rows = await app.query<{ consumer_inbox_count: string }>(
    `SELECT sample.consumer_inbox_count($1)::text AS consumer_inbox_count`,
    [consumer],
  );
  return Number(rows.rows[0]?.consumer_inbox_count ?? 0);
}

describe('[K09-T01] read_subscribed يعيد المشترَك فقط وبعد after مرتباً', () => {
  it('returns only subscribed types, after the cursor, ordered by log_seq', async () => {
    const consumer = new Consumer(
      { connectionString: urlFor('app_sample', db.name), name: 'k09-t01', schema: 'sample', subscriptions: ['sample.item_renamed'] },
      async () => undefined,
    );
    consumers.push(consumer);
    await consumer.subscribe();

    const rows = await app.query<{ event_type: string; log_seq: string }>(
      `SELECT event_type, log_seq FROM messaging.read_subscribed('k09-t01', 0, 100)`,
    );
    for (const r of rows.rows) expect(r.event_type).toBe('sample.item_renamed');

    const seqs = rows.rows.map((r) => Number(r.log_seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // After a cursor, nothing at or below it comes back.
    const last = seqs.at(-1) ?? 0;
    const after = await app.query(`SELECT 1 FROM messaging.read_subscribed('k09-t01', $1, 100)`, [
      last,
    ]);
    expect(after.rowCount).toBe(0);
    await consumer.close();
  });
});

describe('[K09-T02] G4: المعالجة والـinbox والـoffset في معاملة واحدة', () => {
  it('a failing handler leaves the effect, the inbox row and the cursor untouched', async () => {
    const name = 'k09-t02';
    const seen: ConsumedEvent[] = [];
    const consumer = makeConsumer(name, seen, { failOn: () => true });
    await consumer.subscribe();

    await publish([{ tenant_id: TENANT_A, aggregate_seq: 1 }]);

    const before = await offsetOf(name);
    const outcome = await consumer.pollOnce();

    expect(outcome.kind).toBe('processed');
    if (outcome.kind === 'processed') {
      expect(outcome.handled).toBe(0);
      expect(outcome.deadLettered).toBeGreaterThanOrEqual(1);
    }

    // Nothing was applied, and the cursor did not move past the failed event.
    expect(await results(name)).toEqual([]);
    expect(await offsetOf(name)).toBe(before);

    expect(await inboxCount(name)).toBe(0);
  });
});

describe('[K09-T03] E-07: إعادة التشغيل بعد الانهيار لا تُنتج أثراً مزدوجاً', () => {
  it('replays after a rolled-back effect without duplicating it', async () => {
    const name = 'k09-t03';
    const seen: ConsumedEvent[] = [];
    const consumer = makeConsumer(name, seen);
    await consumer.subscribe();

    await publish([{ tenant_id: TENANT_A, aggregate_seq: 1 }]);

    // The crash window: the effect was written but the transaction died before
    // COMMIT, so PostgreSQL discards it.
    await expect(
      inTenantTx(app, { tenantId: TENANT_A }, async () => {
        await app.query(
          `INSERT INTO sample.consumer_result (id, tenant_id, consumer, event_id, seq)
           VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), TENANT_A, name, randomUUID(), 1],
        );
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');

    const before = await results(name);
    expect(before).toEqual([]);

    // Replay: exactly one effect, not two.
    await consumer.pollOnce();
    const after = await results(name);
    expect(after.length).toBe(1);

    // A second replay is a no-op thanks to the inbox key (E-07).
    await consumer.pollOnce();
    expect((await results(name)).length).toBe(1);
  });
});

describe('[K09-T04] E-08: نسختان على الاشتراك نفسه — واحدة فقط تعالج', () => {
  it('serialises replicas so the batch is handled exactly once', async () => {
    const name = 'k09-t04';
    const seenA: ConsumedEvent[] = [];
    const seenB: ConsumedEvent[] = [];

    await withRoleConnectionLimit('app_sample', 8, async () => {
      const a = makeConsumer(name, seenA);
      const b = makeConsumer(name, seenB);
      await a.subscribe();

      await publish([{ tenant_id: TENANT_A, aggregate_seq: 1 }]);

      // Both replicas poll the same subscription at the same moment.
      const outcomes = await Promise.all([a.pollOnce(), b.pollOnce()]);
      const kinds = outcomes.map((o) => o.kind);

      // Exactly one replica did the work; the other was excluded by the lock.
      expect(kinds.filter((k) => k === 'processed')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'lost-lock')).toHaveLength(1);
      expect(await results(name)).toHaveLength(1);
    });
  });
});

describe('[K09-T05] E-09: الفجوة تُوقف الـAggregate ثم تُكمَل بالترتيب', () => {
  it('parks a forward gap, then applies 4 before 5 once the hole is filled', async () => {
    const name = 'k09-t05';
    const seen: ConsumedEvent[] = [];
    const consumer = makeConsumer(name, seen);
    await consumer.subscribe();

    const aggregateId = randomUUID();
    // Seqs 1..3 arrive first and are applied, so the cursor sits at 3.
    await publish([
      { tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 1 },
      { tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 2 },
      { tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 3 },
    ]);
    await consumer.pollOnce();
    expect((await results(name)).map((r) => Number(r.seq))).toEqual([1, 2, 3]);

    // 5 arrives with 4 missing: it must be parked, not applied.
    await publish([{ tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 5 }]);
    const parkedOutcome = await consumer.pollOnce();
    expect(parkedOutcome.kind).toBe('processed');
    if (parkedOutcome.kind === 'processed') expect(parkedOutcome.parked).toBe(1);
    expect((await results(name)).map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(await parkedRows(name)).toEqual([{ aggregate_seq: '5', expected_seq: '4' }]);

    // 4 arrives: it is applied, and the released 5 follows.
    await publish([{ tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 4 }]);
    await consumer.pollOnce();
    await consumer.pollOnce();

    expect((await results(name)).map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
    expect(await parkedRows(name)).toEqual([]);
  });
});

describe('[K09-T06] حدث بـaggregate_seq مكرر أو أقدم يُتجاوز', () => {
  it('skips a sequence at or below the applied one instead of parking it', async () => {
    const name = 'k09-t06';
    const seen: ConsumedEvent[] = [];
    const consumer = makeConsumer(name, seen);
    await consumer.subscribe();

    const aggregateId = randomUUID();
    await publish([
      { tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 1 },
      { tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 2 },
    ]);
    await consumer.pollOnce();
    expect((await results(name)).map((r) => Number(r.seq))).toEqual([1, 2]);

    // A late duplicate of seq 2 must not be treated as a gap.
    await publish([{ tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 2 }]);
    await consumer.pollOnce();

    expect(await parkedRows(name)).toEqual([]);
    expect((await results(name)).map((r) => Number(r.seq))).toEqual([1, 2]);
  });
});

describe('[K09-T07] موقوف أكثر من 5 دقائق يولّد تنبيهاً', () => {
  it('reports parked aggregates older than the alert threshold', async () => {
    const name = 'k09-t07';
    const seen: ConsumedEvent[] = [];
    const consumer = makeConsumer(name, seen);
    await consumer.subscribe();

    const aggregateId = randomUUID();
    await publish([{ tenant_id: TENANT_A, aggregate_id: aggregateId, aggregate_seq: 9 }]);
    await consumer.pollOnce();
    expect(await parkedRows(name)).toHaveLength(1);

    // Fresh: below the threshold.
    expect(await consumer.staleAggregates()).toEqual([]);
    expect(await consumer.parkedAggregates()).toHaveLength(1);

    // Fake clock: move the park time six minutes into the past.
    await queryInDatabase(
      db.name,
      `UPDATE sample.parked_event SET parked_at = now() - interval '6 minutes' WHERE consumer = $1`,
      [name],
    );

    const stale = await consumer.staleAggregates();
    expect(stale).toHaveLength(1);
    expect(stale[0]!.expectedSeq).toBe(1);
    expect(stale[0]!.ageSeconds).toBeGreaterThan(300);
  });
});

describe('[K09-T08] Backoff أسّي مع Jitter', () => {
  it('grows from ~1s to 5min and never exceeds the cap', () => {
    expect(backoffDelayMs(1, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(2, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(4000);

    // Jitter stays inside ±30% of the base.
    for (const random of [0, 0.25, 0.75, 1]) {
      const v = backoffDelayMs(4, () => random);
      expect(v).toBeGreaterThanOrEqual(8000 * 0.7);
      expect(v).toBeLessThanOrEqual(16000 * 1.3);
    }

    // Never above the five-minute ceiling, however many attempts.
    expect(backoffDelayMs(50, () => 1)).toBeLessThanOrEqual(300_000);
    expect(backoffDelayMs(MAX_ATTEMPTS, () => 0.5)).toBeLessThanOrEqual(300_000);
  });
});

describe('[K09-T09] E-11: حدث سام → dead_letter، وحده يُوقَف، ثم replay', () => {
  it('dead-letters after max attempts, parks only that aggregate, and replay releases it', async () => {
    const name = 'k09-t09';
    const seen: ConsumedEvent[] = [];
    const poisonAggregate = randomUUID();
    const healthyAggregate = randomUUID();

    const consumer = makeConsumer(name, seen, {
      maxAttempts: 2,
      failOn: (e) => e.aggregateId === poisonAggregate,
    });
    await consumer.subscribe();

    await publish([
      { tenant_id: TENANT_A, aggregate_id: poisonAggregate, aggregate_seq: 1 },
      { tenant_id: TENANT_A, aggregate_id: healthyAggregate, aggregate_seq: 1 },
    ]);

    // First attempt fails and is recorded; the healthy aggregate still flows.
    await consumer.pollOnce();
    expect((await results(name)).map((r) => r.seq)).toEqual(['1']);

    // Second attempt reaches maxAttempts, so the event is dead-lettered and the
    // cursor moves past it — only the poison aggregate is held back.
    await consumer.pollOnce();

    const dlq = await deadLetters(name);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect(dlq[0]!.log_seq).not.toBeNull();

    // The fix: replay that aggregate and let the consumer run again.
    const replayed = await app.query<{ dlq_replay_aggregate: number }>(
      `SELECT sample.dlq_replay_aggregate($1, $2) AS dlq_replay_aggregate`,
      [name, poisonAggregate],
    );
    expect(replayed.rows[0]!.dlq_replay_aggregate).toBe(1);

    expect(await deadLetters(name)).toHaveLength(0);

    // After the fix the event is re-read and applied.
    const fixed = makeConsumer(name, seen);
    await fixed.pollOnce();
    expect((await results(name)).map((r) => Number(r.seq))).toEqual([1, 1]);
  });
});

describe('[K09-T10] dlq_skip يرفض بلا سبب ويكتب قيد تدقيق', () => {
  it('requires a textual reason and audits the skip', async () => {
    const name = 'k09-t10';
    const agg = randomUUID();
    const consumer = makeConsumer(name, [], {
      maxAttempts: 1,
      failOn: () => true,
    });
    await consumer.subscribe();
    await publish([{ tenant_id: TENANT_A, aggregate_id: agg, aggregate_seq: 1 }]);
    await consumer.pollOnce();

    const dlq = await deadLetters(name);
    expect(dlq).toHaveLength(1);

    // A skip with no reason is refused outright.
    const err = await app
      .query(`SELECT sample.dlq_skip($1, '  ')`, [dlq[0]!.id])
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/requires a reason/i);

    // A reasoned skip succeeds and leaves an audit trail.
    const before = await queryInDatabase<{ c: number }>(
      db.name,
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE action = 'MESSAGING.DLQ_SKIP'`,
    );
    await inTenantTx(app, { tenantId: TENANT_A, userId: randomUUID() }, async () => {
      await app.query(`SELECT sample.dlq_skip($1, $2)`, [dlq[0]!.id, 'known bad payload, patch shipped']);
    });
    const after = await queryInDatabase<{ c: number }>(
      db.name,
      `SELECT count(*)::int AS c FROM audit.audit_entry WHERE action = 'MESSAGING.DLQ_SKIP'`,
    );
    expect(after[0]!.c).toBe(before[0]!.c + 1);

    const skipped = await deadLetters(name);
    expect(skipped[0]!.skipped_reason).toContain('known bad payload');
  });
});

describe('[K09-T11] المستهلك لا يقرأ dead_letter لمستهلك آخر', () => {
  it('hides another consumer\'s dead letters and other tenants\' rows', async () => {
    const mine = 'k09-t11-a';
    const other = 'k09-t11-b';
    const consumer = makeConsumer(mine, [], { maxAttempts: 1, failOn: () => true });
    await consumer.subscribe();
    await publish([{ tenant_id: TENANT_A, aggregate_id: randomUUID(), aggregate_seq: 1 }]);
    await consumer.pollOnce();

    expect(await deadLetters(mine)).toHaveLength(1);

    // The operational view is scoped to the consumer that asks for it.
    expect(await deadLetters(other)).toHaveLength(0);

    // And another tenant sees none of this tenant's rows.
    const otherTenant = await inTenantTx(app, { tenantId: TENANT_B }, async () =>
      app.query<{ c: number }>(`SELECT count(*)::int AS c FROM sample.dead_letter WHERE consumer = $1`, [
        mine,
      ]),
    );
    expect(otherTenant.rows[0]!.c).toBe(0);
  });
});

describe('[K09-T12] المستهلك يكتب بنتيجة سياق الحدث لا سياق ثابت', () => {
  it('writes effects under the tenant carried by each event', async () => {
    const name = 'k09-t12';
    const consumer = makeConsumer(name, []);
    await consumer.subscribe();

    // Two tenants in one batch: each effect must land under its own tenant.
    await publish([
      { tenant_id: TENANT_A, aggregate_id: randomUUID(), aggregate_seq: 1 },
      { tenant_id: TENANT_B, aggregate_id: randomUUID(), aggregate_seq: 1 },
    ]);
    await consumer.pollOnce();

    const rows = await queryInDatabase<{ tenant_id: string }>(
      db.name,
      `SELECT tenant_id FROM sample.consumer_result WHERE consumer = $1 ORDER BY tenant_id`,
      [name],
    );
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });
});
