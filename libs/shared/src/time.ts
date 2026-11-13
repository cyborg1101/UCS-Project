/**
 * Time helpers (K06-T07). All instants are UTC; a timestamp without a zone is rejected.
 */

const ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/** Parse an ISO-8601 instant. Throws if the string carries no timezone designator. */
export function parseInstant(iso: string): Date {
  if (typeof iso !== 'string' || !ZONE_RE.test(iso)) {
    throw new RangeError(`Timestamp without timezone is rejected: ${String(iso)}`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid instant: ${iso}`);
  return d;
}

/** Always emit UTC ISO-8601 with milliseconds and a `Z` suffix. */
export function toUtcIso(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new RangeError('toUtcIso() requires a valid Date');
  }
  return d.toISOString();
}

/** Round-trip check used by tests and by the outbox envelope builder. */
export function utcRoundTrip(iso: string): string {
  return toUtcIso(parseInstant(iso));
}

export function nowUtc(): Date {
  return new Date();
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const SECOND_MS = 1_000;
