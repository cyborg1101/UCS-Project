import { createHmac, timingSafeEqual } from 'node:crypto';
import { CrossTenantAccess, InvalidPublicId } from './errors';
import { formatUuid, isUuid, uuidToBytes } from './ids';

/**
 * Public identifiers (K06-T02..T04, AC-039).
 *
 *   {tenantCode:2}{base32(uuidv7):26}{hmac8:8}
 *
 * The tenant code and the HMAC are bound together, so a public id minted for
 * tenant A cannot be replayed in tenant B: the signature check fails, and the
 * caller must emit SECURITY.CROSS_TENANT_ACCESS rather than a 404.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TENANT_CODE_RE = /^[A-Z]{2}$/;
export const PUBLIC_ID_RE = /^[A-Z]{2}[A-Z2-7]{26}[A-Za-z0-9_-]{8}$/;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new InvalidPublicId({ reason: 'bad_base32_char' });
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface PublicIdCodecOptions {
  /** HMAC key. In production this comes from OpenBao; tests inject a fixed key. */
  secret: string;
}

function sign(tenantCode: string, uuid: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${tenantCode}:${uuid}`)
    .digest('base64url')
    .slice(0, 8);
}

export class PublicIdCodec {
  private readonly secret: string;

  constructor(opts: PublicIdCodecOptions) {
    if (!opts?.secret) throw new Error('PublicIdCodec requires a secret');
    this.secret = opts.secret;
  }

  encode(tenantCode: string, uuid: string): string {
    if (!TENANT_CODE_RE.test(tenantCode)) {
      throw new InvalidPublicId({ reason: 'bad_tenant_code', tenantCode });
    }
    if (!isUuid(uuid)) throw new InvalidPublicId({ reason: 'bad_uuid', uuid });
    const body = base32Encode(uuidToBytes(uuid));
    return `${tenantCode}${body}${sign(tenantCode, uuid, this.secret)}`;
  }

  /** Decode and verify. Throws InvalidPublicId on any tampering (K06-T03). */
  decode(publicId: string): { tenantCode: string; uuid: string } {
    if (typeof publicId !== 'string' || publicId.length !== 36) {
      throw new InvalidPublicId({ reason: 'bad_length' });
    }
    const tenantCode = publicId.slice(0, 2);
    const body = publicId.slice(2, 28);
    const mac = publicId.slice(28);

    if (!TENANT_CODE_RE.test(tenantCode)) throw new InvalidPublicId({ reason: 'bad_tenant_code' });

    let bytes: Uint8Array;
    try {
      bytes = base32Decode(body);
    } catch {
      throw new InvalidPublicId({ reason: 'bad_base32' });
    }
    if (bytes.length !== 16) throw new InvalidPublicId({ reason: 'bad_uuid_length' });

    const uuid = formatUuid(bytes);
    const expected = sign(tenantCode, uuid, this.secret);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InvalidPublicId({ reason: 'bad_signature' });
    }
    return { tenantCode, uuid };
  }

  /**
   * Decode in the context of the *current* tenant (K06-T04).
   * A valid signature from another tenant raises CrossTenantAccess.
   */
  decodeForTenant(publicId: string, currentTenantCode: string): string {
    let decoded: { tenantCode: string; uuid: string };
    try {
      decoded = this.decode(publicId);
    } catch (err) {
      if (err instanceof InvalidPublicId) {
        // A structurally valid id whose signature verifies under a different
        // tenant code is an attempted cross-tenant access, not a malformed id.
        const alt = this.tryDecodeAnyTenant(publicId);
        if (alt && alt.tenantCode !== currentTenantCode) {
          throw new CrossTenantAccess({
            reason: 'cross_tenant_public_id',
            targetTenant: alt.tenantCode,
          });
        }
      }
      throw err;
    }
    if (decoded.tenantCode !== currentTenantCode) {
      throw new CrossTenantAccess({
        reason: 'cross_tenant_public_id',
        targetTenant: decoded.tenantCode,
      });
    }
    return decoded.uuid;
  }

  private tryDecodeAnyTenant(publicId: string): { tenantCode: string; uuid: string } | null {
    if (publicId.length !== 36) return null;
    try {
      const tenantCode = publicId.slice(0, 2);
      const bytes = base32Decode(publicId.slice(2, 28));
      if (bytes.length !== 16) return null;
      const uuid = formatUuid(bytes);
      const mac = publicId.slice(28);
      const expected = sign(tenantCode, uuid, this.secret);
      if (mac === expected) return { tenantCode, uuid };
      return null;
    } catch {
      return null;
    }
  }
}
