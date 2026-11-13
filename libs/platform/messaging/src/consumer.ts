import { Pool, type PoolClient } from 'pg';
import type { Logger } from '@ucs/shared';

/**
 * Consumer framework (K-09).
 *
 * The correctness rules live in the database, and this class only expresses the
 * protocol:
 *
 *  - G4  : the handler's writes, the inbox row and the offset advance commit in
 *          ONE transaction, so a failure leaves all three untouched.
 *  - E-07: a crash after handling but before commit replays the batch; the inbox
 *          unique key makes the second attempt a no-op.
 *  - E-08: two replicas on one subscription serialise on the offset row via
 *          FOR UPDATE SKIP LOCKED - exactly one handles a batch.
 *  - E-09: a gap in aggregate_seq parks that aggregate only; the rest advance.
 *  - E-11: an event that keeps failing moves to dead_letter, parking only its
 *          aggregate; dlq_replay_aggregate() releases it after the fix.
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
 * effects must go through `tx` so they share the inbox/offset transaction.
 */
export type ConsumerHandler = (
  event: ConsumedEvent,
  tx: ConsumerTx,
) => Promise<void>;

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

/** K09-T08: exponential backoff with jitter, 1s .. 5min, 10 attempts. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 300_000);
  const jitter = base * 0.3 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export const MAX_ATTEMPTS = 10;

export class Consumer {
  readonly #pool: Pool;
  readonly #config: Required<Omit<ConsumerConfig, 'connectionString' | 'logger'>> & {
    connectionString: string;
    logger?: Logger;
  };
  readonly #handler: ConsumerHandler;
  #stopped = false;

  constructor(config: ConsumerConfig, handler: ConsumerHandler) {
    this.#config = {
      batchSize: 50,
      pollIntervalMs: 500,
      maxAttempts: MAX_ATTEMPTS,
      parkedAlertSeconds: 300,
      ...config,
    };
    this.#handler = handler;
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: 1,
      application_name: `ums-consumer-${config.name}`,
    });
  }

  async close(): Promise<void> {
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
    } finally {
      c.release();
    }
  }

  /** One batch. Public so tests can drive it deterministically. */
  async pollOnce(): Promise<BatchOutcome> {
    const client = await this.#pool.connect();
    try {
      // E-08: the lock on the offset row is what makes one replica win.
      await client.query('BEGIN');
      let offset: string;
      try {
        const locked = await client.query<{ log_seq: string }>(
          `SELECT log_seq FROM ${this.#config.schema}.offset
            WHERE consumer = $1 FOR UPDATE SKIP LOCKED`,
          [this.#config.name],
        );
        if (locked.rowCount === 0) {
          await client.query('ROLLBACK');
          return { kind: 'lost-lock' };
        }
        offset = locked.rows[0]!.log_seq;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }

      const events = await client.query<LogRow>(
        `SELECT * FROM messaging.read_subscribed($1, $2, $3)`,
        [this.#config.name, offset, this.#config.batchSize],
      );
      if (events.rowCount === 0) return { kind: 'idle' };

      let handled = 0;
      let parked = 0;
      let deadLettered = 0;

      for (const row of events.rows) {
        const event = toEvent(row);

        // E-09 / K09-T05: an aggregate with an earlier gap must not be applied.
        if (event.aggregateId && event.aggregateSeq !== null) {
          const gap = await this.#hasGap(client, event);
          if (gap) {
            parked += 1;
            continue;
          }
        }

        const result = await this.#handleOne(client, event);
        if (result === 'ok') handled += 1;
        else if (result === 'duplicate') handled += 1;
        else deadLettered += 1;
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

  /**
   * True when an earlier aggregate_seq is still unprocessed for this consumer.
   * Uses the recorded max_seq per aggregate in the inbox table.
   */
  async #hasGap(client: PoolClient, event: ConsumedEvent): Promise<boolean> {
    if (!event.aggregateId || event.aggregateSeq === null) return false;
    const r = await client.query<{ max_seq: string | null }>(
      `SELECT max(aggregate_seq)::text AS max_seq
         FROM ${this.#config.schema}.inbox
        WHERE consumer = $1 AND aggregate_id = $2 AND aggregate_seq IS NOT NULL`,
      [this.#config.name, event.aggregateId],
    );
    const maxSeq = r.rows[0]?.max_seq;
    const expected = maxSeq === null || maxSeq === undefined ? 1 : Number(maxSeq) + 1;
    // Only a *forward* jump is a gap. An older or repeated sequence is a
    // duplicate (K09-T06) and must be skipped, not parked.
    return event.aggregateSeq > expected;
  }

  async #handleOne(
    client: PoolClient,
    event: ConsumedEvent,
  ): Promise<'ok' | 'duplicate' | 'dead'> {
    // G4 / E-07: handler effects + inbox + offset advance in a single tx.
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [event.tenantId]);
      await client.query(`SELECT set_config('app.correlation_id', $1, true)`, [
        event.correlationId ?? '',
      ]);

      const seen = await client.query(
        `SELECT 1 FROM ${this.#config.schema}.inbox WHERE consumer = $1 AND event_id = $2`,
        [this.#config.name, event.eventId],
      );
      if (seen.rowCount && seen.rowCount > 0) {
        // Idempotent replay: advance the offset, do not re-run the handler.
        await this.#advanceOffset(client, event.logSeq);
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

      await client.query(
        `INSERT INTO ${this.#config.schema}.inbox
           (consumer, event_id, tenant_id, aggregate_id, aggregate_seq)
         VALUES ($1,$2,$3,$4,$5)`,
        [this.#config.name, event.eventId, event.tenantId, event.aggregateId, event.aggregateSeq],
      );

      await this.#advanceOffset(client, event.logSeq);
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.#deadLetter(client, event, err as Error);
      return 'dead';
    }
  }

  async #advanceOffset(client: PoolClient, logSeq: number): Promise<void> {
    await client.query(
      `UPDATE ${this.#config.schema}.offset
          SET log_seq = $1, updated_at = now()
        WHERE consumer = $2 AND log_seq < $1`,
      [logSeq, this.#config.name],
    );
  }

  /** E-11: after maxAttempts the event goes to dead_letter, parking its aggregate. */
  async #deadLetter(client: PoolClient, event: ConsumedEvent, err: Error): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [event.tenantId]);
      const attempts = await client.query<{ attempts: number }>(
        `SELECT attempts FROM ${this.#config.schema}.dead_letter
          WHERE consumer = $1 AND event_id = $2`,
        [this.#config.name, event.eventId],
      );
      const next = (attempts.rows[0]?.attempts ?? 0) + 1;

      if (next >= this.#config.maxAttempts) {
        await client.query(
          `INSERT INTO ${this.#config.schema}.dead_letter
             (id, consumer, event_id, tenant_id, aggregate_id, aggregate_seq,
              payload, error, attempts)
           VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6::jsonb,$7,$8)
           ON CONFLICT (consumer, event_id)
           DO UPDATE SET attempts = $8, error = $7`,
          [
            this.#config.name,
            event.eventId,
            event.tenantId,
            event.aggregateId,
            event.aggregateSeq,
            JSON.stringify(event.payload),
            err.message,
            next,
          ],
        );
        // Only this aggregate is parked; advance past this event so the rest of
        // the log keeps flowing.
        await this.#advanceOffset(client, event.logSeq);
      } else {
        await client.query(
          `INSERT INTO ${this.#config.schema}.dead_letter
             (id, consumer, event_id, tenant_id, aggregate_id, aggregate_seq,
              payload, error, attempts)
           VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6::jsonb,$7,$8)
           ON CONFLICT (consumer, event_id)
           DO UPDATE SET attempts = $8, error = $7`,
          [
            this.#config.name,
            event.eventId,
            event.tenantId,
            event.aggregateId,
            event.aggregateSeq,
            JSON.stringify(event.payload),
            err.message,
            next,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.#config.logger?.error({ err: e }, 'failed to dead-letter event');
    }
  }
}
