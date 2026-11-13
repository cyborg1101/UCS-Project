import { z } from 'zod';
import { EventContractViolation, isUlid, isUuid, toUtcIso } from '@ucs/shared';

/**
 * Event envelope (K08-T02) and contract registry (K08-T03, K11-T01).
 *
 * Every published event carries the same envelope. The registry holds one Zod
 * schema per `<module>.<event>.v<N>`; publishing an event whose type is not
 * registered, or whose payload does not match, raises EventContractViolation
 * *before* the database is touched.
 */
export interface EventEnvelope {
  event_id: string;
  tenant_id: string;
  producer: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_seq: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  correlation_id: string | null;
  causation_id: string | null;
  occurred_at: string;
}

const envelopeShape = z.object({
  event_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  producer: z.string().min(1),
  event_type: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  event_version: z.number().int().positive(),
  aggregate_type: z.string().min(1),
  aggregate_id: z.string().uuid(),
  aggregate_seq: z.number().int().positive(),
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).default({}),
  correlation_id: z.string().nullable(),
  causation_id: z.string().uuid().nullable(),
  occurred_at: z.string(),
});

export interface ContractEntry {
  type: string;
  version: number;
  payload: z.ZodTypeAny;
  /** Declared in the module manifest (K14-T08) as notification-worthy. */
  emitsNotification?: boolean;
  description?: string;
}

export class ContractRegistry {
  private readonly contracts = new Map<string, ContractEntry>();

  register(entry: ContractEntry): this {
    this.contracts.set(`${entry.type}.v${entry.version}`, entry);
    return this;
  }

  has(type: string, version: number): boolean {
    return this.contracts.has(`${type}.v${version}`);
  }

  get(type: string, version: number): ContractEntry | undefined {
    return this.contracts.get(`${type}.v${version}`);
  }

  list(): ContractEntry[] {
    return [...this.contracts.values()];
  }

  /**
   * K08-T03: payload-only check. Deliberately independent of the envelope so a
   * caller can reject a bad payload *before* it asks the database for an
   * aggregate sequence — publishing must never change state on a bad contract.
   */
  assertPayload(eventType: string, version: number, payload: Record<string, unknown>): void {
    const contract = this.get(eventType, version);
    if (!contract) {
      throw new EventContractViolation({
        eventType,
        version,
        reason: 'no_registered_contract',
      });
    }

    const parsed = contract.payload.safeParse(payload);
    if (!parsed.success) {
      throw new EventContractViolation({
        eventType,
        reason: 'payload_mismatch',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
  }

  /** K08-T03: envelope + payload validation, before any database call. */
  validate(envelope: EventEnvelope): void {
    const shape = envelopeShape.safeParse(envelope);
    if (!shape.success) {
      throw new EventContractViolation({
        eventType: envelope.event_type,
        issues: shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    this.assertPayload(envelope.event_type, envelope.event_version, envelope.payload);
  }
}

export interface BuildEnvelopeInput {
  eventId: string;
  tenantId: string;
  producer: string;
  eventType: string;
  eventVersion?: number;
  aggregateType: string;
  aggregateId: string;
  aggregateSeq: number;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt?: Date;
}

/** K08-T02: the envelope completes itself; callers supply only the essentials. */
export function buildEnvelope(input: BuildEnvelopeInput): EventEnvelope {
  if (!isUuid(input.eventId)) throw new EventContractViolation({ reason: 'event_id_not_uuid' });
  if (!isUuid(input.tenantId)) throw new EventContractViolation({ reason: 'tenant_not_uuid' });
  if (!isUuid(input.aggregateId)) throw new EventContractViolation({ reason: 'aggregate_not_uuid' });
  if (input.correlationId != null && !isUlid(input.correlationId)) {
    throw new EventContractViolation({ reason: 'correlation_not_ulid' });
  }

  return {
    event_id: input.eventId,
    tenant_id: input.tenantId,
    producer: input.producer,
    event_type: input.eventType,
    event_version: input.eventVersion ?? 1,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    aggregate_seq: input.aggregateSeq,
    payload: input.payload,
    metadata: input.metadata ?? {},
    correlation_id: input.correlationId ?? null,
    causation_id: input.causationId ?? null,
    occurred_at: toUtcIso(input.occurredAt ?? new Date()),
  };
}

/**
 * The Phase 0 registry. Modules register their own contracts on startup; the
 * gate check:contracts compares this list with db/schemas-contract/*.json.
 */
export const contractRegistry = new ContractRegistry()
  .register({
    type: 'sample.item_created',
    version: 1,
    description: 'A sample module item was created',
    payload: z.object({
      itemId: z.string().uuid(),
      name: z.string().min(1),
      seq: z.number().int().positive(),
    }),
  })
  .register({
    type: 'sample.item_renamed',
    version: 1,
    description: 'A sample module item was renamed',
    emitsNotification: true,
    payload: z.object({
      itemId: z.string().uuid(),
      from: z.string(),
      to: z.string().min(1),
    }),
  })
  .register({
    type: 'kernel.job_due',
    version: 1,
    description: 'A scheduled kernel job became due',
    payload: z.object({
      jobId: z.string().uuid(),
      module: z.string(),
      jobType: z.string(),
      payload: z.record(z.unknown()).default({}),
    }),
  });
