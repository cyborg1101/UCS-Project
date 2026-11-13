import 'reflect-metadata';
import { IdempotencyKeyMissing } from '@ucs/shared';
import type { Executor } from '../db/tenant-database';
import type { IdempotencyService } from './idempotency-service';

/**
 * `@Idempotent()` (K-10).
 *
 * Marks a write handler as requiring an `Idempotency-Key`. The decorator only
 * records the intent; the interceptor is what enforces it, so the rule travels
 * with the method instead of being repeated in every controller.
 */
export const IDEMPOTENT_META = 'ucs:idempotent';

export interface IdempotentMetadata {
  /** Module schema that owns the `idempotency_key` table. */
  schema: string;
  /** Optional per-endpoint retention override (hours). */
  ttlHours?: number;
}

export function Idempotent(options: IdempotentMetadata): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    Reflect.defineMetadata(IDEMPOTENT_META, options, descriptor.value as object);
    return descriptor;
  };
}

export function idempotentMetadataOf(handler: unknown): IdempotentMetadata | undefined {
  if (typeof handler !== 'function') return undefined;
  return Reflect.getMetadata(IDEMPOTENT_META, handler) as IdempotentMetadata | undefined;
}

/**
 * What the HTTP layer must supply. Kept deliberately tiny: the interceptor has
 * no dependency on Express or Nest, so the same logic runs under the real API
 * and under integration tests.
 */
export interface IdempotentRequest {
  /** Value of the `Idempotency-Key` header, or null when absent. */
  idempotencyKey: string | null;
  /** Parsed request body — the payload the key is bound to. */
  payload: unknown;
}

export interface IdempotentCall {
  metadata: IdempotentMetadata;
  request: IdempotentRequest;
  /** The transaction the work must run in. */
  tx: Executor;
  /** The actual handler body. */
  work: (tx: Executor) => Promise<unknown>;
  /**
   * Injectable clock (K10-T07). Must reach the service, otherwise the retention
   * window is measured against wall-clock time and can never be exercised.
   */
  now?: () => Date;
}

export interface IdempotentResult {
  /** Headers the caller should set on the response (K10-T02 `DUPLICATE`). */
  headers: Record<string, string>;
  body: unknown;
  duplicate: boolean;
}

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * The interceptor logic.
 *
 * It is a plain function rather than a Nest `NestInterceptor` class so the
 * guarantee can be tested against a real PostgreSQL transaction without
 * standing up an HTTP server. The Nest provider in `apps/api` is a thin adapter
 * that calls exactly this function.
 *
 * A missing key is rejected BEFORE touching the database (K10-T01): there is
 * nothing to claim, and failing early keeps the 400 cheap.
 */
export async function runIdempotent(
  service: IdempotencyService,
  call: IdempotentCall,
): Promise<IdempotentResult> {
  const { metadata, request, tx, work, now } = call;

  // K10-T01: a write marked @Idempotent without a key is a client error.
  const key = request.idempotencyKey?.trim();
  if (!key) throw new IdempotencyKeyMissing();

  const outcome = await service.run(
    tx,
    {
      schema: metadata.schema,
      key,
      payload: request.payload,
      ...(metadata.ttlHours === undefined ? {} : { ttlHours: metadata.ttlHours }),
      ...(now === undefined ? {} : { now }),
    },
    work,
  );

  return {
    body: outcome.response,
    duplicate: outcome.duplicate,
    headers: {
      [IDEMPOTENCY_HEADER]: key,
      // K10-T02: the client can distinguish a replay from a fresh execution.
      'Idempotency-Replayed': outcome.duplicate ? 'true' : 'false',
      ...(outcome.duplicate ? { 'Idempotency-Status': 'DUPLICATE' } : {}),
    },
  };
}
