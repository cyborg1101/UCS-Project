import { type Logger } from '@ucs/shared';
import { createLogger } from '@ucs/shared';
import type { ContextStore } from './request-context';

/**
 * K03-T06 — every log line carries correlation_id and tenant_id automatically.
 * Callers never pass them; the mixin reads the active context.
 */
export function createContextLogger(
  store: ContextStore,
  opts: { level?: string; service?: string; destination?: NodeJS.WritableStream } = {},
): Logger {
  return createLogger({
    level: opts.level,
    destination: opts.destination,
    context: () => store.logFields(),
  });
}

export type { Logger };
