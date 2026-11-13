import { contextStore, type Executor } from '@ucs/kernel';
import { uuidv7 } from '@ucs/shared';
import {
  buildEnvelope,
  contractRegistry,
  type ContractRegistry,
  type EventEnvelope,
} from './envelope';

/**
 * Outbox append (K08-T01/T02/T04).
 *
 * Runs inside the caller's business transaction: the event and the state change
 * commit or roll back together, so there is never an event without its effect
 * nor an effect without its event.
 *
 * aggregate_seq comes from sample.next_aggregate_seq(), which serialises on the
 * aggregate row, so two concurrent appends cannot collide or skip a value.
 */
export interface AppendEventInput {
  tenantId: string;
  producer: string;
  eventType: string;
  eventVersion?: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt?: Date;
  /** Optional explicit sequence; otherwise taken from the aggregate counter. */
  aggregateSeq?: number;
  registry?: ContractRegistry;
}

export interface AppendedEvent extends EventEnvelope {
  outboxId: string;
}

export async function appendEvent(tx: Executor, input: AppendEventInput): Promise<AppendedEvent> {
  const registry = input.registry ?? contractRegistry;
  const eventVersion = input.eventVersion ?? 1;

  // K08-T03: a bad contract must fail BEFORE the database is touched — not
  // after next_aggregate_seq() has already consumed a sequence value.
  registry.assertPayload(input.eventType, eventVersion, input.payload);

  let seq = input.aggregateSeq;
  if (seq === undefined) {
    const rows = await tx.query<{ next_aggregate_seq: string }>(
      `SELECT sample.next_aggregate_seq($1, $2) AS next_aggregate_seq`,
      [input.aggregateId, input.tenantId],
    );
    seq = Number(rows[0]!.next_aggregate_seq);
  }

  // K08-T02: correlation comes from the request context unless overridden, so a
  // module never has to thread it through by hand.
  const ctx = contextStore.tryGet();
  const correlationId = input.correlationId ?? ctx?.correlation_id ?? null;

  const envelope = buildEnvelope({
    eventId: uuidv7(),
    tenantId: input.tenantId,
    producer: input.producer,
    eventType: input.eventType,
    eventVersion,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateSeq: seq,
    payload: input.payload,
    metadata: input.metadata,
    correlationId,
    causationId: input.causationId,
    occurredAt: input.occurredAt,
  });

  // Full envelope validation as well, so a malformed id/tenant cannot slip in.
  registry.validate(envelope);

  await tx.execute(
    `INSERT INTO sample.outbox
       (id, tenant_id, aggregate_type, aggregate_id, aggregate_seq, event_type,
        event_version, payload, metadata, correlation_id, causation_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)`,
    [
      envelope.event_id,
      envelope.tenant_id,
      envelope.aggregate_type,
      envelope.aggregate_id,
      envelope.aggregate_seq,
      envelope.event_type,
      envelope.event_version,
      JSON.stringify(envelope.payload),
      JSON.stringify(envelope.metadata),
      envelope.correlation_id,
      envelope.causation_id,
      envelope.occurred_at,
    ],
  );

  return { ...envelope, outboxId: envelope.event_id };
}
