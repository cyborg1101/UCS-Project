import Decimal from 'decimal.js';

/**
 * Money value object (K06-T05, K06-T06).
 *
 * Rules enforced here:
 *  - The only accepted constructor input is a decimal *string* (never a JS number).
 *  - Arithmetic uses decimal.js, so 0.1 + 0.2 === 0.3 exactly.
 *  - Rounding is half-up to 2 decimals.
 *  - Mixing currencies throws.
 */
export const MONEY_SCALE = 2;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export class Money {
  private readonly value: Decimal;
  readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    this.value = value;
    this.currency = currency;
  }

  /** Build from a decimal string, e.g. Money.of('12.50', 'SDG'). */
  static of(amount: string, currency: string): Money {
    if (typeof amount !== 'string') {
      throw new TypeError('Money.of() accepts only a decimal string, never a JS number');
    }
    if (!DECIMAL_RE.test(amount.trim())) {
      throw new TypeError(`Money.of() received a non-decimal string: ${amount}`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new TypeError(`Money currency must be a 3-letter ISO code, got: ${currency}`);
    }
    return new Money(new Decimal(amount.trim()), currency);
  }

  static zero(currency: string): Money {
    return Money.of('0', currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Cannot operate on different currencies: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  /** Multiply by an integer/quantity (non-monetary factor, given as a string). */
  mul(factor: string): Money {
    return new Money(this.value.times(new Decimal(factor)), this.currency);
  }

  /** Divide by a non-monetary divisor given as a string. */
  div(divisor: string): Money {
    return new Money(this.value.dividedBy(new Decimal(divisor)), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  /** Half-up rounded to 2 decimals, serialised as a plain decimal string. */
  toFixed(scale: number = MONEY_SCALE): string {
    return this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(scale);
  }

  /** Rounded copy of this Money to the ledger scale. */
  round(scale: number = MONEY_SCALE): Money {
    return new Money(this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP), this.currency);
  }

  /** Raw decimal string, unrounded (use toFixed() for persistence). */
  toString(): string {
    return this.value.toString();
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toFixed(), currency: this.currency };
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  compare(other: Money): number {
    this.assertSameCurrency(other);
    return this.value.comparedTo(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }
}
