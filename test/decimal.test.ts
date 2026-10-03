import { describe, expect, it } from 'vitest';
import { Decimal, DecimalArithmeticError } from '../src/lang/decimal.js';

describe('Decimal', () => {
  it('parses and prints values', () => {
    expect(Decimal.fromString('1234.567').toString()).toBe('1234.567');
    expect(Decimal.fromString('-12.30').toString()).toBe('-12.30');
    expect(Decimal.fromString('0.5').toString()).toBe('0.5');
    expect(Decimal.fromString('42').toString()).toBe('42');
  });

  it('parses scientific notation', () => {
    expect(Decimal.fromString('1.5e3').toString()).toBe('1500');
    expect(Decimal.fromString('1.5e-3').toString()).toBe('0.0015');
    expect(Decimal.fromString('-2E2').toString()).toBe('-200');
  });

  it('rejects invalid input', () => {
    expect(() => Decimal.fromString('abc')).toThrow(DecimalArithmeticError);
    expect(() => Decimal.fromString('1.2.3')).toThrow(DecimalArithmeticError);
    expect(() => Decimal.fromNumber(Number.NaN)).toThrow(DecimalArithmeticError);
    expect(() => Decimal.fromNumber(Number.POSITIVE_INFINITY)).toThrow(DecimalArithmeticError);
  });

  it('adds and subtracts exactly', () => {
    expect(Decimal.fromString('0.1').add(Decimal.fromString('0.2')).toString()).toBe('0.3');
    expect(Decimal.fromString('1.00').subtract(Decimal.fromString('0.001')).toString()).toBe('0.999');
  });

  it('multiplies exactly', () => {
    expect(Decimal.fromString('1.5').multiply(Decimal.fromString('2.5')).toString()).toBe('3.75');
    expect(Decimal.fromString('0.1').multiply(Decimal.fromString('0.1')).toString()).toBe('0.01');
  });

  it('divides with rounding half away from zero', () => {
    expect(Decimal.fromString('1').divide(Decimal.fromString('4')).toString()).toBe('0.25');
    expect(Decimal.fromString('1').divide(Decimal.fromString('3')).toString()).toBe('0.3333333333');
    expect(Decimal.fromString('2').divide(Decimal.fromString('3')).toString()).toBe('0.6666666667');
    expect(Decimal.fromString('-2').divide(Decimal.fromString('3')).toString()).toBe('-0.6666666667');
  });

  it('rejects division by zero', () => {
    expect(() => Decimal.fromString('1').divide(Decimal.fromString('0'))).toThrow(DecimalArithmeticError);
  });

  it('compares values across scales', () => {
    expect(Decimal.fromString('1.50').equals(Decimal.fromString('1.5'))).toBe(true);
    expect(Decimal.fromString('1.5').compare(Decimal.fromString('1.51'))).toBe(-1);
    expect(Decimal.fromString('-1').compare(Decimal.fromString('1'))).toBe(-1);
  });

  it('counts integer and fraction digits', () => {
    expect(Decimal.fromString('1234.567').integerDigits()).toBe(4);
    expect(Decimal.fromString('1234.567').fractionDigits()).toBe(3);
    expect(Decimal.fromString('0.5').integerDigits()).toBe(0);
    expect(Decimal.fromString('1.500').fractionDigits()).toBe(1);
    expect(Decimal.fromString('0').integerDigits()).toBe(0);
  });

  it('preserves exactness far beyond double precision', () => {
    const big = Decimal.fromString('123456789123456789.123456789');
    expect(big.add(Decimal.fromString('0.000000001')).toString()).toBe('123456789123456789.123456790');
  });
});
