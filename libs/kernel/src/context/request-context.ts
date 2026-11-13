import { AsyncLocalStorage } from 'node:async_hooks';
import { ContextMissingError, isUlid, ulid } from '@ucs/shared';

/**
 * Request context (K-03).
 *
 * One immutable object per request, carried by AsyncLocalStorage. Because the
 * object is frozen and the storage is async-context-local, it survives nested
 * and parallel awaits without leaking between concurrent requests (K03-T03).
 */
export type DeviceKind = 'web' | 'mobile' | 'kiosk' | 'system';
export type ClientKind = 'web' | 'flutter' | 'api' | 'worker' | 'test';

export interface RequestContext {
  readonly correlation_id: string;
  readonly tenant_id: string | null;
  readonly tenant_code: string | null;
  readonly user_id: string | null;
  readonly roles: readonly string[];
  readonly permission_scope: readonly string[];
  readonly device_id: string | null;
  readonly device_kind: DeviceKind | null;
  readonly client: ClientKind;
  readonly idempotency_key: string | null;
  /** Always read from the server clock — never from a client header (K03-T04). */
  readonly request_time_server: Date;
  readonly request_id: string;
  readonly trace_id: string | null;
}

/** Mutable per-request state that is not part of the identity payload. */
interface TxState {
  depth: number;
}

const storage = new AsyncLocalStorage<{ ctx: RequestContext; tx: TxState }>();

/** Correlation ids arriving from clients are only honoured when well-formed (K03-T05). */
export function normaliseCorrelationId(raw: unknown): string {
  if (typeof raw === 'string' && isUlid(raw.trim().toUpperCase())) {
    return raw.trim().toUpperCase();
  }
  return ulid();
}

export interface BuildContextInput {
  correlationId?: unknown;
  tenantId?: string | null;
  tenantCode?: string | null;
  userId?: string | null;
  roles?: readonly string[];
  permissionScope?: readonly string[];
  deviceId?: string | null;
  deviceKind?: DeviceKind | null;
  client?: ClientKind;
  idempotencyKey?: string | null;
  traceId?: string | null;
  /** Injectable clock (fake timers in tests). Defaults to the server clock. */
  now?: () => Date;
}

export function buildContext(input: BuildContextInput = {}): RequestContext {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    correlation_id: normaliseCorrelationId(input.correlationId),
    tenant_id: input.tenantId ?? null,
    tenant_code: input.tenantCode ?? null,
    user_id: input.userId ?? null,
    roles: Object.freeze([...(input.roles ?? [])]),
    permission_scope: Object.freeze([...(input.permissionScope ?? [])]),
    device_id: input.deviceId ?? null,
    device_kind: input.deviceKind ?? null,
    client: input.client ?? 'api',
    idempotency_key: input.idempotencyKey ?? null,
    request_time_server: now(),
    request_id: ulid(),
    trace_id: input.traceId ?? null,
  });
}

export class ContextStore {
  /** Run `fn` with `ctx` bound to the async context. */
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run({ ctx, tx: { depth: 0 } }, fn);
  }

  /** K03-T01: reading outside a request is a programming error, not a null. */
  get(): RequestContext {
    const entry = storage.getStore();
    if (!entry) throw new ContextMissingError();
    return entry.ctx;
  }

  tryGet(): RequestContext | undefined {
    return storage.getStore()?.ctx;
  }

  /** Replace the context inside the current scope (used after auth resolution). */
  update(patch: Partial<RequestContext>): RequestContext {
    const entry = storage.getStore();
    if (!entry) throw new ContextMissingError();
    const next = Object.freeze({ ...entry.ctx, ...patch });
    entry.ctx = next;
    return next;
  }

  /** P-05 marker: set while a database transaction is open (K04-T04). */
  isInTransaction(): boolean {
    return (storage.getStore()?.tx.depth ?? 0) > 0;
  }

  enterTransaction(): void {
    const entry = storage.getStore();
    if (!entry) throw new ContextMissingError();
    entry.tx.depth += 1;
  }

  exitTransaction(): void {
    const entry = storage.getStore();
    if (entry && entry.tx.depth > 0) entry.tx.depth -= 1;
  }

  transactionDepth(): number {
    return storage.getStore()?.tx.depth ?? 0;
  }

  /** Fields required in every structured log line (K03-T06). */
  logFields(): { correlation_id: string | null; tenant_id: string | null } {
    const ctx = this.tryGet();
    return { correlation_id: ctx?.correlation_id ?? null, tenant_id: ctx?.tenant_id ?? null };
  }
}

/** Process-wide store. NestJS providers receive it, tests may construct their own. */
export const contextStore = new ContextStore();
