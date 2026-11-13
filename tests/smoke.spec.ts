/**
 * [K01-T03] Vitest smoke test.
 * These tests prove the toolchain itself works before any kernel code exists.
 */
import { describe, expect, it } from 'vitest';

describe('[K01-T03] toolchain smoke', () => {
  it('runs vitest and can assert', () => {
    expect(1 + 1).toBe(2);
  });

  it('has node >= 22 (BigInt, structuredClone, fetch available)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
