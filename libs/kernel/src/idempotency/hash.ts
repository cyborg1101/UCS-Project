import { createHash } from 'node:crypto';

/**
 * Deterministic serialisation for idempotency payload hashing (K10-T08).
 *
 * Two requests are "the same request" only if their payloads carry the same
 * meaning. `JSON.stringify` alone does not give that: object key order is
 * insertion-order, so `{a,b}` and `{b,a}` hash differently and a client that
 * merely reordered its body would be told its key was reused with a different
 * payload (422) — a false positive that would reject a legitimate retry.
 *
 * Keys are therefore sorted recursively, at every depth. Arrays keep their
 * order: `[1,2]` and `[2,1]` really are different lists.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      // Mirror JSON.stringify: an undefined member is absent, not null.
      if (v === undefined) continue;
      out[key] = canonicalise(v);
    }
    return out;
  }
  return value;
}

/** SHA-256 over the canonical form. Stable across key order, types preserved. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
