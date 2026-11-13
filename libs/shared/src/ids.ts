import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit big-endian millisecond timestamp, then random.
 * Time-ordered ids keep B-tree inserts sequential (K06-T01).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  // 48-bit timestamp
  b.writeUIntBE(nowMs, 0, 6);
  // version 7
  b[6] = ((b[6]! & 0x0f) | 0x70) & 0xff;
  // variant 10xx
  b[8] = ((b[8]! & 0x3f) | 0x80) & 0xff;
  return formatUuid(b);
}

export function formatUuid(b: Uint8Array): string {
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`invalid uuid: ${uuid}`);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function uuidFromBytes(b: Uint8Array): string {
  return formatUuid(b);
}

/** Milliseconds encoded in a UUIDv7 (0 for non-v7 uuids). */
export function uuidv7Time(uuid: string): number {
  const b = uuidToBytes(uuid);
  return Buffer.from(b.subarray(0, 6)).readUIntBE(0, 6);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** ULID used for correlation ids (SAD §7.3). Crockford base32, 26 chars. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number = Date.now()): string {
  const time = Buffer.alloc(6);
  time.writeUIntBE(nowMs, 0, 6);
  const rand = randomBytes(10);
  const bytes = Buffer.concat([time, rand]); // 16 bytes -> 26 chars

  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, 26);
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}
