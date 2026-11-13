import { Pool, type PoolClient } from 'pg';
import type { Logger } from '@ucs/shared';
import { TIMEOUTS } from '@ucs/kernel';

/**
 * Consumer framework (K-09).
 *
 * The correctness rules live in the database; this class expresses the protocol.
 *
 *  - G4  : handler writes, inbox row and cursor advance share ONE transaction per
 *          event, so a failure leaves all three untouched.
 *  - E-07: a crash after handling but before commit replays the event; the inbox
 *          primary key makes the second attempt a no-op.
 *  - E-08: replicas exclude each other with a session advisory lock held for the
 *          whole batch. A row lock released after reading would let both handle
 *          the same events.
 *  - E-09: a forward gap in aggregate_seq parks the event in `parked_event`,
 *          recording why and since when, so the condition is observable rather
 *          than an in-process counter nothing can alert on.
 *  - E-11: a persistently failing event moves to dead_letter, parking only its
 *          aggregate; dlq_replay_aggregate() rewinds the cursor after the fix.
 *
 * Consumer state is cross-tenant by nature (a cursor spans every tenant's
 * events), and it must be read before an event — and therefore a tenant — is
 * known. Every such read/write therefore goes through a `sample.consumer_*`
 * SECURITY DEFINER function owned by the NOLOGIN `consumer_reader` role, which
 * the RLS policies admit. Reading `sample.offset` directly here would leave
 * `app.tenant_id` unset, so FORCE RLS would filter every row away and the cursor
 * would stay at 0 forever.
 */
export interface ConsumerConfig {
  connectionString: string;
  /** Consumer name, unique across the cluster; used as the inbox/offset key. */
  name: string;
  /** Module schema that owns this consumer's inbox/offset/dead_letter tables. */
  schema: string;
  /** Event types this consumer subscribes to. */
  subscriptions: string[];
  batchSize?: number;
  pollIntervalMs?: number;
  /** E-11: attempts before dead-lettering. */
  maxAttempts?: number;
  /** K09-T07: alert when an aggregate stays parked longer than this. */
  parkedAlertSeconds?: number;
  logger?: Logger;
}

export interface ConsumedEvent {
  logSeq: number;
  eventId: string;
  tenantId: string;
  producer: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string | null;
  aggregateId: string | null;
  aggregateSeq: number | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  causationId: string | null;
  occurredAt: Date;
}

/**
 * A handler receives the event plus a tenant-scoped transaction executor. All
 * effects must go through `tx` so they share the inbox/cursor transaction.
 */
export type ConsumerHandler = (event: ConsumedEvent, tx: ConsumerTx) => Promise<void>;

export interface ConsumerTx {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<number>;
}

export type BatchOutcome =
  | { kind: 'idle' }
  | { kind: 'lost-lock' }
  | { kind: 'processed'; handled: number; parked: number; deadLettered: number };

interface LogRow {
  log_seq: string;
  event_id: string;
  tenant_id: string;
  producer: string;
  event_type: string;
  event_version: number;
  aggregate_type: string | null;
  aggregate_id: string | null;
  aggregate_seq: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  causation_id: string | null;
  occurred_at: Date;
}

function toEvent(r: LogRow): ConsumedEvent {
  return {
    logSeq: Number(r.log_seq),
    eventId: r.event_id,
    tenantId: r.tenant_id,
    producer: r.producer,
    eventType: r.event_type,
    eventVersion: r.event_version,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateSeq: r.aggregate_seq === null ? null : Number(r.aggregate_seq),
    payload: r.payload,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    occurredAt: r.occurred_at,
  };
}

/**
 * K09-T08: exponential backoff with jitter, 1s .. 5min.
 *
 * The ceiling is applied to the FINAL value, after jitter. Capping only the
 * base would let the +30% jitter push a long-delay retry past five minutes,
 * which silently breaks the documented contract.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 300_000);
  const jitter = base * 0.3 * (random() * 2 - 1);
  return Math.max(0, Math.min(300_000, Math.round(base + jitter)));
}

export const MAX_ATTEMPTS = 10;

export interface ParkedAggregate {
  consumer: string;
  aggregateId: string;
  aggregateSeq: number;
  expectedSeq: number;
  parkedAt: Date;
  ageSeconds: number;
}

export class Consumer {
  readonly #pool: Pool;
  readonly #config: Required<Omit<ConsumerConfig, 'connectionString' | 'logger'>> & {
    connectionString: string;
    logger?: Logger;
  };
  readonly #handler: ConsumerHandler;
  #stopped = false;
  #lockClient: PoolClient | null = null;

  constructor(config: ConsumerConfig, handler: ConsumerHandler) {
    this.#config = {
      batchSize: 50,
      pollIntervalMs: 500,
      maxAttempts: MAX_ATTEMPTS,
      parkedAlertSeconds: 300,
      ...config,
    };
    this.#handler = handler;
    // max 1: the advisory lock is session-scoped, so it must live on a
    // connection this process owns for its whole lifetime.
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: 1,
      application_name: `ums-consumer-${config.name}`,
    });
  }

  async close(): Promise<void> {
    if (this.#lockClient) {
      const held = this.#lockClient;
      // Clear the field first: the client is about to be released, and close()
      // being called twice (or re-entrantly) must not double-release, which pg
      // throws on.
      this.#lockClient = null;
      await held
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [this.#lockKey()])
        .catch(() => undefined);
      held.release();
    }
    await this.#pool.end();
  }

  stop(): void {
    this.#stopped = true;
  }

  /** Register this consumer's subscriptions (idempotent). */
  async subscribe(): Promise<void> {
    const c = await this.#pool.connect();
    try {
      for (const type of this.#config.subscriptions) {
        await c.query(`SELECT messaging.subscribe($1, $2)`, [this.#config.name, type]);
      }
      const head = await c.query<{ max_log_seq: string }>(
        `SELECT messaging.max_log_seq()::text AS max_log_seq`,
      );
      await c.query(`SELECT ${this.#config.schema}.consumer_ensure($1, $2)`, [
        this.#config.name,
        Number(head.rows[0]?.max_log_seq ?? 0),
      ]);
    } finally {
      c.release();
    }
  }

  /** One batch. Public so tests drive it deterministically. */
  async pollOnce(): Promise<BatchOutcome> {
    const client = await this.#pool.connect();
    try {
      const headRes = await client.query<{ max_log_seq: string }>(
        `SELECT messaging.max_log_seq()::text AS max_log_seq`,
      );
      const offsetFallback = Number(headRes.rows[0]?.max_log_seq ?? 0);
      // E-08: hold the subscription for the whole batch.
      if (!(await this.#acquireLock(client))) return { kind: 'lost-lock' };

      await client.query(`SELECT ${this.#config.schema}.consumer_ensure($1, $2)`, [
        this.#config.name,
        offsetFallback,
      ]);

      const offsetRes = await client.query<{ consumer_offset: string }>(
        `SELECT ${this.#config.schema}.consumer_offset($1) AS consumer_offset`,
        [this.#config.name],
      );
      const offset = Number(offsetRes.rows[0]?.consumer_offset ?? 0);

      const events = await client.query<LogRow>(
        `SELECT * FROM messaging.read_subscribed($1, $2, $3)`,
        [this.#config.name, offset, this.#config.batchSize],
      );
      if ((events.rowCount ?? 0) === 0) return { kind: 'idle' };

      let handled = 0;
      let parked = 0;
      let deadLettered = 0;
      /**
       * Earliest log_seq that must be attempted again (K09-T02 partial failure,
       * E-11). Later events may legitimately be handled — a poison event parks
       * only its own aggregate — but the cursor must never move past the
       * failure, because the cursor only moves forward and the retry would
       * otherwise never happen.
       */
      let blockedAt: number | null = null;

      for (const row of events.rows) {
        const event = toEvent(row);

        if (await this.#isParked(client, event)) {
          parked += 1;
          continue;
        }

        const state = await this.#aggregateState(client, event);
        if (state.kind === 'gap') {
          await this.#park(client, event, state.expected);
          parked += 1;
          // Everything after a gap must wait: advancing past it would apply a
          // later state on top of a missing one.
          break;
        }
        if (state.kind === 'duplicate') {
          // K09-T06: a repeated or older sequence is already applied. Move the
          // cursor past it, but never run the handler a second time.
          await client.query(`SELECT ${this.#config.schema}.consumer_advance($1, $2)`, [
            this.#config.name,
            event.logSeq,
          ]);
          handled += 1;
          continue;
        }

        const result = await this.#handleOne(client, event);
        if (result === 'ok' || result === 'duplicate') {
          handled += 1;
        } else if (result === 'dead') {
          deadLettered += 1;
        } else {
          // Not exhausted yet: remember the position and keep draining, so one
          // poison event cannot stall every other tenant's events.
          if (blockedAt === null || event.logSeq < blockedAt) blockedAt = event.logSeq;
        }
      }

      if (blockedAt !== null) {
        // Hand the failed position back to the next poll. Effects already
        // applied in this batch stay applied; the inbox key makes their replay
        // a no-op, so rewinding costs nothing.
        await client.query(`SELECT ${this.#config.schema}.consumer_rewind($1, $2)`, [
          this.#config.name,
          blockedAt - 1,
        ]);
      }

      return { kind: 'processed', handled, parked, deadLettered };
    } finally {
      client.release();
    }
  }

  async run(): Promise<void> {
    await this.subscribe();
    while (!this.#stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.#config.logger?.error({ err }, 'consumer batch failed');
      }
      if (!this.#stopped) await new Promise((r) => setTimeout(r, this.#config.pollIntervalMs));
    }
  }

  /** K09-T07: aggregates parked longer than the alert threshold. */
  async staleAggregates(): Promise<ParkedAggregate[]> {
    const parked = await this.parkedAggregates();
    return parked.filter((p) => p.ageSeconds >= this.#config.parkedAlertSeconds);
  }

  async parkedAggregates(): Promise<ParkedAggregate[]> {
    const client = await this.#pool.connect();
    try {
      const res = await client.query<{
        consumer: string;
        aggregate_id: string;
        aggregate_seq: string;
        expected_seq: string;
        parked_at: Date;
        age_seconds: string;
      }>(`SELECT * FROM ${this.#config.schema}.parked_for_consumer($1)`, [this.#config.name]);
      return res.rows.map((r) => ({
        consumer: r.consumer,
        aggregateId: r.aggregate_id,
        aggregateSeq: Number(r.aggregate_seq),
        expectedSeq: Number(r.expected_seq),
        parkedAt: r.parked_at,
        ageSeconds: Number(r.age_seconds),
      }));
    } finally {
      client.release();
    }
  }

  #lockKey(): string {
    return `${this.#config.schema}.consumer.${this.#config.name}`;
  }

  async #acquireLock(client: PoolClient): Promise<boolean> {
    // Advisory locks are re-entrant per session: calling pg_try_advisory_lock
    // again on the same connection increments a counter, so a single unlock in
    // close() would never release it and every other replica would block
    // forever. Re-acquiring on a connection that already holds it is a bug.
    if (this.#lockClient === client) return true;

    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [this.#lockKey()],
    );
    const locked = res.rows[0]?.locked ?? false;
    if (locked) this.#lockClient = client;
    return locked;
  }

  /**
   * Classify the event against the aggregate's progress.
   *
   *  - 'ok'        : it is exactly the next sequence, so apply it.
   *  - 'gap'       : it jumps forward, so park it and wait for the hole.
   *  - 'duplicate' : it is at or below what was already applied, so skip it.
   *
   * Collapsing 'duplicate' into 'ok' would re-apply the effect; collapsing
   * 'gap' into 'ok' would apply a later state on top of a missing one.
   */
  async #aggregateState(
    client: PoolClient,
    event: ConsumedEvent,
  ): Promise<{ kind: 'ok' | 'duplicate' } | { kind: 'gap'; expected: number }> {
    if (!event.aggregateId || event.aggregateSeq === null) return { kind: 'ok' };
    const r = await client.query<{ consumer_applied_seq: string | null }>(
      `SELECT ${this.#config.schema}.consumer_applied_seq($1, $2) AS consumer_applied_seq`,
      [this.#config.name, event.aggregateId],
    );
    const applied = r.rows[0]?.consumer_applied_seq;
    const expected = applied === null || applied === undefined ? 1 : Number(applied) + 1;
    if (event.aggregateSeq < expected) return { kind: 'duplicate' };
    if (event.aggregateSeq > expected) return { kind: 'gap', expected };
    return { kind: 'ok' };
  }

  async #isParked(client: PoolClient, event: ConsumedEvent): Promise<boolean> {
    const r = await client.query<{ consumer_is_parked: boolean }>(
      `SELECT ${this.#config.schema}.consumer_is_parked($1, $2) AS consumer_is_parked`,
      [this.#config.name, event.eventId],
    );
    return r.rows[0]?.consumer_is_parked ?? false;
  }

  async #park(client: PoolClient, event: ConsumedEvent, expected: number): Promise<void> {
    await client.query(
      `SELECT ${this.#config.schema}.consumer_park($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.#config.name,
        event.eventId,
        event.tenantId,
        event.aggregateId,
        event.aggregateSeq,
        expected,
        event.logSeq,
      ],
    );
  }

  async #handleOne(
    client: PoolClient,
    event: ConsumedEvent,
  ): Promise<'ok' | 'duplicate' | 'dead' | 'retry'> {
    const t = TIMEOUTS.background;
    // G4 / E-07: handler effects + inbox + cursor advance in a single tx.
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [event.tenantId]);
      await client.query(`SELECT set_config('app.correlation_id', $1, true)`, [
        event.correlationId ?? '',
      ]);
      await client.query(`SET LOCAL statement_timeout = ${Number(t.statementTimeoutMs)}`);
      await client.query(`SET LOCAL lock_timeout = ${Number(t.lockTimeoutMs)}`);

      const seen = await client.query<{ consumer_seen: boolean }>(
        `SELECT ${this.#config.schema}.consumer_seen($1, $2) AS consumer_seen`,
        [this.#config.name, event.eventId],
      );
      if (seen.rows[0]?.consumer_seen) {
        // Idempotent replay: advance the cursor, do not re-run the handler.
        await client.query(`SELECT ${this.#config.schema}.consumer_advance($1, $2)`, [
          this.#config.name,
          event.logSeq,
        ]);
        await client.query('COMMIT');
        return 'duplicate';
      }

      const tx: ConsumerTx = {
        async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
          const res = await client.query(sql, params);
          return res.rows as T[];
        },
        async execute(sql: string, params: unknown[] = []) {
          const res = await client.query(sql, params);
          return res.rowCount ?? 0;
        },
      };

      await this.#handler(event, tx);

      await client.query(`SELECT ${this.#config.schema}.consumer_record($1,$2,$3,$4,$5,$6)`, [
        this.#config.name,
        event.eventId,
        event.tenantId,
        event.aggregateId,
        event.aggregateSeq,
        event.logSeq,
      ]);

      // A gap filled by this event unblocks the aggregate's followers.
      if (event.aggregateId && event.aggregateSeq !== null) {
        const rel = await client.query<{ consumer_release_followers: string | null }>(
          `SELECT ${this.#config.schema}.consumer_release_followers($1,$2,$3) AS consumer_release_followers`,
          [this.#config.name, event.aggregateId, event.aggregateSeq],
        );
        const earliest = rel.rows[0]?.consumer_release_followers;
        if (earliest !== null && earliest !== undefined) {
          // Rewind so the followers are re-read, in order, on the next poll.
          await client.query(`SELECT ${this.#config.schema}.consumer_rewind($1, $2)`, [
            this.#config.name,
            Number(earliest) - 1,
          ]);
        }
      }

      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const exhausted = await this.#deadLetter(client, event, err as Error);
      // Only an exhausted event may be skipped past; anything else must be
      // retried at the same position.
      return exhausted ? 'dead' : 'retry';
    }
  }

  /** E-11: after maxAttempts the event goes to dead_letter, parking its aggregate. */
  async #deadLetter(
    client: PoolClient,
    event: ConsumedEvent,
    err: Error,
  ): Promise<boolean> {
    try {
      const res = await client.query<{ consumer_dead_letter: number }>(
        `SELECT ${this.#config.schema}.consumer_dead_letter($1,$2,$3,$4,$5,$6::jsonb,$7,$8) AS consumer_dead_letter`,
        [
          this.#config.name,
          event.eventId,
          event.tenantId,
          event.aggregateId,
          event.aggregateSeq,
          JSON.stringify(event.payload),
          err.message,
          event.logSeq,
        ],
      );
      const attempts = Number(res.rows[0]?.consumer_dead_letter ?? 0);
      if (attempts >= this.#config.maxAttempts) {
        // Only this aggregate is parked; advance past this event so the rest of
        // the log keeps flowing.
        await client.query(`SELECT ${this.#config.schema}.consumer_advance($1, $2)`, [
          this.#config.name,
          event.logSeq,
        ]);
        return true;
      }
      return false;
    } catch (e) {
      this.#config.logger?.error({ err: e }, 'failed to dead-letter event');
      return false;
    }
  }
}
