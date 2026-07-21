/**
 * Exact fixed-point decimal arithmetic backed by BigInt.
 *
 * A Decimal is `units * 10^-scale` where `units` is a BigInt and `scale` is
 * the number of digits after the decimal point. All arithmetic is exact
 * except division, which rounds half-away-from-zero at the result scale.
 */
export class DecimalArithmeticError extends Error {}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export class Decimal {
  private constructor(
    readonly units: bigint,
    readonly scale: number,
  ) {}

  static make(units: bigint, scale: number): Decimal {
    if (!Number.isSafeInteger(scale) || scale < 0) {
      throw new DecimalArithmeticError(`Invalid decimal scale ${scale}`);
    }
    return new Decimal(units, scale);
  }

  /** Parses "123", "-12.34", or scientific notation like "1.5e3". */
  static fromString(text: string): Decimal {
    const match = DECIMAL_PATTERN.exec(text.trim());
    if (!match) throw new DecimalArithmeticError(`Invalid decimal value '${text}'`);
    const [, sign, intPart, fracPart = '', expPart] = match;
    const exponent = expPart === undefined ? 0 : Number(expPart);
    if (!Number.isSafeInteger(exponent)) {
      throw new DecimalArithmeticError(`Invalid decimal value '${text}'`);
    }
    let units = BigInt(intPart! + fracPart);
    let scale = fracPart.length - exponent;
    if (scale < 0) {
      units *= pow10(-scale);
      scale = 0;
    }
    if (sign === '-') units = -units;
    return new Decimal(units, scale);
  }

  static fromBigInt(value: bigint): Decimal {
    return new Decimal(value, 0);
  }

  static fromNumber(value: number): Decimal {
    if (!Number.isFinite(value)) {
      throw new DecimalArithmeticError(`Cannot convert ${value} to a decimal`);
    }
    return Decimal.fromString(String(value));
  }

  /** Returns an equal Decimal with the given (larger or equal) scale. */
  rescale(scale: number): Decimal {
    if (scale === this.scale) return this;
    if (scale < this.scale) {
      throw new DecimalArithmeticError('Cannot reduce decimal scale without rounding');
    }
    return new Decimal(this.units * pow10(scale - this.scale), scale);
  }

  add(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.rescale(scale).units + other.rescale(scale).units, scale);
  }

  subtract(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.rescale(scale).units - other.rescale(scale).units, scale);
  }

  multiply(other: Decimal): Decimal {
    return new Decimal(this.units * other.units, this.scale + other.scale).trimmed();
  }

  /**
   * Divides, producing a result at scale max(this.scale, other.scale, 10),
   * rounded half-away-from-zero, then trimmed of trailing zeros.
   */
  divide(other: Decimal): Decimal {
    if (other.units === 0n) throw new DecimalArithmeticError('Division by zero');
    const scale = Math.max(this.scale, other.scale, 10);
    // value = this / other; result units at `scale` = this.units * 10^(scale - this.scale + other.scale) / other.units.
    // Compute one extra digit for round-half-away-from-zero.
    const shifted = this.units * pow10(scale - this.scale + other.scale + 1);
    const quotient = shifted / other.units; // BigInt division truncates toward zero
    const negative = quotient < 0n;
    const abs = negative ? -quotient : quotient;
    const rounded = (abs + 5n) / 10n;
    return new Decimal(negative ? -rounded : rounded, scale).trimmed();
  }

  negate(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  compare(other: Decimal): -1 | 0 | 1 {
    const scale = Math.max(this.scale, other.scale);
    const a = this.rescale(scale).units;
    const b = other.rescale(scale).units;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  /** Returns an equal Decimal with trailing fractional zeros removed. */
  trimmed(): Decimal {
    let units = this.units;
    let scale = this.scale;
    while (scale > 0 && units % 10n === 0n) {
      units /= 10n;
      scale -= 1;
    }
    return scale === this.scale ? this : new Decimal(units, scale);
  }

  /** Number of digits before the decimal point (0 when the integer part is zero, sign excluded). */
  integerDigits(): number {
    const abs = this.units < 0n ? -this.units : this.units;
    const integerPart = abs / pow10(this.scale);
    return integerPart === 0n ? 0 : integerPart.toString().length;
  }

  /** Number of significant digits after the decimal point (trailing zeros excluded). */
  fractionDigits(): number {
    return this.trimmed().scale;
  }

  toString(): string {
    const negative = this.units < 0n;
    const abs = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const sign = negative ? '-' : '';
    if (this.scale === 0) return sign + abs;
    const intPart = abs.slice(0, abs.length - this.scale);
    const fracPart = abs.slice(abs.length - this.scale);
    return `${sign}${intPart}.${fracPart}`;
  }
}
