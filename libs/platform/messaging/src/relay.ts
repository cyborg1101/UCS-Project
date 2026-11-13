import { Pool, type PoolClient } from 'pg';
import type { Logger } from '@ucs/shared';

/**
 * Relay (K-08).
 *
 * Moves rows from every module's outbox into messaging.event_log. Three
 * properties matter and each is enforced by the database, not by this code:
 *
 *  - gap-free log_seq        : messaging.relay_batch() takes it from a counter row
 *  - exactly-once append     : event_dedup on event_id
 *  - single writer           : writer_lease with a fencing epoch (E-03/E-04)
 *
 * Crash safety (E-01/E-02) follows from doing the whole move in ONE
 * transaction: fetch + append + ack commit together or not at all.
 */
export interface RelayConfig {
  connectionString: string;
  /** Module schemas whose outbox this relay drains. */
  producers: Array<{ schema: string; producer: string }>;
  batchSize?: number;
  pollIntervalMs?: number;
  leaseTtlSeconds?: number;
  owner?: string;
  logger?: Logger;
}

export interface RelayCycleResult {
  acquired: boolean;
  epoch: number | null;
  fetched: number;
  appended: number;
  acked: number;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_seq: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  correlation_id: string | null;
  causation_id: string | null;
  occurred_at: Date;
}

export class Relay {
  readonly #pool: Pool;
  readonly #config: Required<Omit<RelayConfig, 'connectionString' | 'logger'>> & {
    connectionString: string;
    logger?: Logger;
  };
  #epoch: number | null = null;
  #stopped = false;

  constructor(config: RelayConfig) {
    this.#config = {
      batchSize: 100,
      pollIntervalMs: 500,
      leaseTtlSeconds: 15,
      owner: `${process.env.HOSTNAME ?? 'relay'}-${process.pid}`,
      ...config,
    };
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: 1,
      application_name: 'ums-relay',
    });
  }

  get epoch(): number | null {
    return this.#epoch;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async healthy(): Promise<boolean> {
    const c = await this.#pool.connect();
    try {
      await c.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      c.release();
    }
  }

  /**
   * One relay cycle. Public so tests can drive it deterministically instead of
   * racing a background timer (K-R4: wait on a condition, never on a clock).
   */
  async cycle(): Promise<RelayCycleResult> {
    const client = await this.#pool.connect();
    try {
      const epoch = await this.#ensureLease(client);
      if (epoch === null) {
        return { acquired: false, epoch: null, fetched: 0, appended: 0, acked: 0 };
      }

      let fetched = 0;
      let appended = 0;
      let acked = 0;

      for (const { schema } of this.#config.producers) {
        // E-01/E-02: fetch, append and ack must share ONE transaction. The
        // FOR UPDATE SKIP LOCKED inside outbox_fetch is worthless if it commits
        // before the append, and a crash between them would either lose rows or
        // re-publish them.
        await client.query('BEGIN');
        try {
          const rows = await client.query<OutboxRow>(
            `SELECT * FROM ${schema}.outbox_fetch($1)`,
            [this.#config.batchSize],
          );
          if (rows.rowCount === 0) {
            await client.query('COMMIT');
            continue;
          }

          fetched += rows.rowCount ?? 0;
          const ids = rows.rows.map((r) => r.id);

          const events = rows.rows.map((r) => ({
            event_id: r.id,
            tenant_id: r.tenant_id,
            producer: this.producerFor(schema),
            event_type: r.event_type,
            event_version: r.event_version,
            aggregate_type: r.aggregate_type,
            aggregate_id: r.aggregate_id,
            aggregate_seq: Number(r.aggregate_seq),
            payload: r.payload,
            metadata: r.metadata,
            correlation_id: r.correlation_id,
            causation_id: r.causation_id,
            occurred_at: r.occurred_at.toISOString(),
          }));

          const res = await client.query<{ relay_batch: number }>(
            `SELECT messaging.relay_batch($1, $2::jsonb) AS relay_batch`,
            [epoch, JSON.stringify(events)],
          );
          appended += Number(res.rows[0]!.relay_batch);

          await client.query(`SELECT ${schema}.outbox_ack($1::uuid[])`, [ids]);
          acked += ids.length;
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
      }

      return { acquired: true, epoch, fetched, appended, acked };
    } finally {
      client.release();
    }
  }

  /** Background loop for apps/worker. */
  async run(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.cycle();
      } catch (err) {
        this.#config.logger?.error({ err }, 'relay cycle failed');
        this.#epoch = null;
      }
      if (!this.#stopped) await new Promise((r) => setTimeout(r, this.#config.pollIntervalMs));
    }
  }

  stop(): void {
    this.#stopped = true;
  }

  private producerFor(schema: string): string {
    return this.#config.producers.find((p) => p.schema === schema)?.producer ?? schema;
  }

  async #ensureLease(client: PoolClient): Promise<number | null> {
    if (this.#epoch !== null) {
      const ok = await client.query<{ renew_lease: boolean }>(
        `SELECT messaging.renew_lease($1, $2) AS renew_lease`,
        [this.#epoch, this.#config.leaseTtlSeconds],
      );
      if (ok.rows[0]?.renew_lease) return this.#epoch;
      // Lost the lease: fall through and try to acquire (bumps the epoch, so
      // any in-flight write from the old leader is fenced out).
      this.#epoch = null;
    }

    const res = await client.query<{ acquire_lease: string | null }>(
      `SELECT messaging.acquire_lease($1, $2) AS acquire_lease`,
      [this.#config.owner, this.#config.leaseTtlSeconds],
    );
    const epoch = res.rows[0]?.acquire_lease;
    this.#epoch = epoch == null ? null : Number(epoch);
    return this.#epoch;
  }
}
