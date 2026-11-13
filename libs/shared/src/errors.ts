/**
 * Unified error shape (SAD §7.5 / K06-T08).
 * Messages are i18n keys (`message_key`), never user-facing prose, so the
 * web (RTL) and Flutter clients can localise without server changes.
 */
export type ErrorDetails = Record<string, unknown>;

export interface ErrorPayload {
  code: string;
  message_key: string;
  details: ErrorDetails;
  correlation_id: string | null;
}

export class AppError extends Error {
  readonly code: string;
  readonly messageKey: string;
  readonly details: ErrorDetails;
  readonly httpStatus: number;
  correlationId: string | null = null;

  constructor(
    code: string,
    messageKey: string,
    httpStatus: number,
    details: ErrorDetails = {},
  ) {
    super(`${code}: ${messageKey}`);
    this.name = new.target.name;
    this.code = code;
    this.messageKey = messageKey;
    this.details = details;
    this.httpStatus = httpStatus;
    Error.captureStackTrace?.(this, new.target);
  }

  toPayload(correlationId: string | null): ErrorPayload {
    return {
      code: this.code,
      message_key: this.messageKey,
      details: this.details,
      correlation_id: correlationId ?? this.correlationId,
    };
  }
}

/** K06-T03 — tampered or malformed public identifier. */
export class InvalidPublicId extends AppError {
  constructor(details: ErrorDetails = {}) {
    super('INVALID_PUBLIC_ID', 'errors.invalid_public_id', 400, details);
  }
}

/** AC-039 — a caller touched a resource owned by another tenant. */
export class CrossTenantAccess extends AppError {
  constructor(details: ErrorDetails = {}) {
    super('CROSS_TENANT_ACCESS', 'errors.cross_tenant_access', 403, details);
  }
}

/** K03-T01 — context was read outside a request scope. */
export class ContextMissingError extends AppError {
  constructor() {
    super('CONTEXT_MISSING', 'errors.context_missing', 500);
  }
}

/** K04-T04 / P-05 — external I/O attempted inside a database transaction. */
export class TxBoundaryViolation extends AppError {
  constructor(operation: string) {
    super('TX_BOUNDARY_VIOLATION', 'errors.tx_boundary_violation', 500, { operation });
  }
}

/** K04-T07 — nested withTenantTx call. */
export class NestedTransaction extends AppError {
  constructor() {
    super('NESTED_TRANSACTION', 'errors.nested_transaction', 500);
  }
}

/** K08-T03 — event does not match its registered JSON Schema. */
export class EventContractViolation extends AppError {
  constructor(details: ErrorDetails = {}) {
    super('EVENT_CONTRACT_VIOLATION', 'errors.event_contract_violation', 500, details);
  }
}

/** K10-T03 — idempotency key reused with a different payload. */
export class IdempotencyKeyReused extends AppError {
  constructor(details: ErrorDetails = {}) {
    super('IDEMPOTENCY_KEY_REUSED', 'errors.idempotency_key_reused', 422, details);
  }
}

/** K10-T01 — a write endpoint marked @Idempotent was called without a key. */
export class IdempotencyKeyMissing extends AppError {
  constructor() {
    super('IDEMPOTENCY_KEY_MISSING', 'errors.idempotency_key_missing', 400);
  }
}

/**
 * The resource does not exist *within the caller's tenant*.
 *
 * Deliberately distinct from CrossTenantAccess: a row that belongs to another
 * tenant must answer 403 (AC-039), because telling the caller "not found" would
 * hide the fact that their identifier was valid and is being refused. 404 is
 * reserved for ids that resolve to nothing at all.
 */
export class NotFound extends AppError {
  constructor(details: ErrorDetails = {}) {
    super('NOT_FOUND', 'errors.not_found', 404, details);
  }
}
