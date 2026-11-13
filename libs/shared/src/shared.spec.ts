import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Time, ulid, isUlid } from './ids';
import { Money } from './money';
import { parseInstant, toUtcIso } from './time';
import { PublicIdCodec } from './public-id';
import { CrossTenantAccess, InvalidPublicId } from './errors';

describe('[K06-T01] uuidv7는 زمنياً مرتباً', () => {
  it('produces 1000 monotonically increasing values', () => {
    let prev = '';
    const seen: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = uuidv7(1_700_000_000_000 + i);
      if (prev) expect(id > prev).toBe(true);
      prev = id;
      seen.push(id);
    }
    expect(new Set(seen).size).toBe(1000);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const ts = 1_700_000_123_456;
    expect(uuidv7Time(uuidv7(ts))).toBe(ts);
  });

  it('sets version 7 and RFC variant', () => {
    const id = uuidv7();
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });
});

describe('[K06-T02] الترميز وفكّه للمعرّف العام', () => {
  const codec = new PublicIdCodec({ secret: 'test-secret-key' });

  it('round-trips tenant code and uuid', () => {
    const uuid = uuidv7();
    const publicId = codec.encode('SD', uuid);
    expect(publicId).toHaveLength(36);
    expect(codec.decode(publicId)).toEqual({ tenantCode: 'SD', uuid });
  });

  it('is stable for the same input', () => {
    const uuid = uuidv7();
    expect(codec.encode('SD', uuid)).toBe(codec.encode('SD', uuid));
  });
});

describe('[K06-T03] تعديل المعرّف العام يُفشل التحقق', () => {
  const codec = new PublicIdCodec({ secret: 'test-secret-key' });

  it('rejects a tampered signature', () => {
    const publicId = codec.encode('SD', uuidv7());
    const tampered = publicId.slice(0, 35) + (publicId[35] === 'A' ? 'B' : 'A');
    expect(() => codec.decode(tampered)).toThrow(InvalidPublicId);
  });

  it('rejects a tampered body', () => {
    const publicId = codec.encode('SD', uuidv7());
    const chars = publicId.split('');
    chars[10] = chars[10] === 'A' ? 'B' : 'A';
    expect(() => codec.decode(chars.join(''))).toThrow(InvalidPublicId);
  });

  it('rejects garbage', () => {
    expect(() => codec.decode('nonsense')).toThrow(InvalidPublicId);
    expect(() => codec.decode('')).toThrow(InvalidPublicId);
  });
});

describe('[K06-T04] معرّف مستأجر A لا يُقبل في سياق B (AC-039)', () => {
  const codec = new PublicIdCodec({ secret: 'test-secret-key' });

  it('raises CrossTenantAccess for a foreign tenant code', () => {
    const uuid = uuidv7();
    const publicId = codec.encode('AA', uuid);
    expect(() => codec.decodeForTenant(publicId, 'BB')).toThrow(CrossTenantAccess);
  });

  it('accepts the same tenant', () => {
    const uuid = uuidv7();
    const publicId = codec.encode('AA', uuid);
    expect(codec.decodeForTenant(publicId, 'AA')).toBe(uuid);
  });
});

describe('[K06-T05] Money دقيق ولا يقبل الأعداد العشرية العائمة', () => {
  it('0.1 + 0.2 is exactly 0.3', () => {
    const sum = Money.of('0.1', 'SDG').add(Money.of('0.2', 'SDG'));
    expect(sum.toFixed()).toBe('0.30');
    expect(sum.equals(Money.of('0.3', 'SDG'))).toBe(true);
  });

  it('rounds half-up to 2 decimals', () => {
    expect(Money.of('1.005', 'SDG').toFixed()).toBe('1.01');
    expect(Money.of('1.004', 'SDG').toFixed()).toBe('1.00');
    expect(Money.of('2.675', 'SDG').toFixed()).toBe('2.68');
  });

  it('refuses a JS number at the constructor', () => {
    // @ts-expect-error - numbers are rejected at runtime and by the type system
    expect(() => Money.of(0.1, 'SDG')).toThrow(TypeError);
  });

  it('refuses a non-decimal string', () => {
    expect(() => Money.of('1e5', 'SDG')).toThrow(TypeError);
    expect(() => Money.of('abc', 'SDG')).toThrow(TypeError);
  });
});

describe('[K06-T06] Money يرفض جمع عملتين مختلفتين', () => {
  it('throws on mixed-currency addition', () => {
    expect(() => Money.of('1.00', 'SDG').add(Money.of('1.00', 'USD'))).toThrow();
  });

  it('throws on mixed-currency comparison', () => {
    expect(() => Money.of('1.00', 'SDG').compare(Money.of('1.00', 'USD'))).toThrow();
  });
});

describe('[K06-T07] الأزمنة UTC فقط', () => {
  it('round-trips a UTC instant', () => {
    expect(toUtcIso(parseInstant('2026-01-15T10:00:00Z'))).toBe('2026-01-15T10:00:00.000Z');
  });

  it('rejects a timestamp with no timezone', () => {
    expect(() => parseInstant('2026-01-15T10:00:00')).toThrow(RangeError);
    expect(() => parseInstant('2026-01-15')).toThrow(RangeError);
  });

  it('normalises an offset into UTC', () => {
    expect(toUtcIso(parseInstant('2026-01-15T13:00:00+03:00'))).toBe('2026-01-15T10:00:00.000Z');
  });
});

describe('[K06-T08] صيغة الخطأ الموحدة', () => {
  it('carries code, message_key, details, correlation_id', () => {
    const err = new InvalidPublicId({ reason: 'x' });
    const payload = err.toPayload('01JABC');
    expect(payload).toEqual({
      code: 'INVALID_PUBLIC_ID',
      message_key: 'errors.invalid_public_id',
      details: { reason: 'x' },
      correlation_id: '01JABC',
    });
  });
});

describe('ULID correlation ids', () => {
  it('generates RFC-compatible 26-char ULIDs', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });
});
