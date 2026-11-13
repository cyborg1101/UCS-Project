import pino, { type Logger } from 'pino';

/**
 * Structured logging (K03-T06). Every line carries correlation_id and tenant_id
 * without callers passing them: the context mixin injects them.
 */
export interface LoggerContext {
  correlation_id: string | null;
  tenant_id: string | null;
}

export interface CreateLoggerOptions {
  level?: string;
  context?: () => LoggerContext;
  /** Injectable sink (tests capture JSON here instead of patching stdout). */
  destination?: NodeJS.WritableStream;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const config = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: process.env.SERVICE_NAME ?? 'ums' },
    mixin() {
      const ctx = opts.context?.();
      return { correlation_id: ctx?.correlation_id ?? null, tenant_id: ctx?.tenant_id ?? null };
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      censor: '[REDACTED]',
    },
  };

  return opts.destination ? pino(config, opts.destination) : pino(config);
}

export type { Logger };
