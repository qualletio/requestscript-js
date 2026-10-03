import type { TypeNode } from './ast.js';
import { Decimal, DecimalArithmeticError } from './decimal.js';
import { ParameterError, RuntimeError } from './errors.js';
import {
  INT32_MAX,
  INT32_MIN,
  INT64_MAX,
  INT64_MIN,
  NULL_VALUE,
  booleanValue,
  decimalValue,
  int32Value,
  int64Value,
  listValue,
  objectValue,
  stringValue,
  type Value,
} from './values.js';

/**
 * Types tracked at runtime. This is TypeNode plus 'any', which appears only
 * through inference (e.g. the element type of an empty list literal).
 */
export type RuntimeType =
  | { kind: 'any' }
  | { kind: 'int32' }
  | { kind: 'int64' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'object' }
  | { kind: 'decimal'; intDigits?: number; fracDigits?: number }
  | { kind: 'list'; element: RuntimeType };

export const ANY_TYPE: RuntimeType = { kind: 'any' };

export function typeToString(type: RuntimeType | TypeNode): string {
  switch (type.kind) {
    case 'list':
      return `[]${typeToString(type.element)}`;
    case 'decimal':
      return type.intDigits !== undefined && type.fracDigits !== undefined
        ? `decimal(${type.intDigits}, ${type.fracDigits})`
        : 'decimal';
    default:
      return type.kind;
  }
}

/** A human-readable name for a value's runtime kind, for error messages. */
export function valueTypeName(value: Value): string {
  switch (value.kind) {
    case 'list':
      return value.elements.length > 0 ? `[]${valueTypeName(value.elements[0]!)}` : '[]';
    case 'resource':
      return `resource ${value.resource.name}`;
    default:
      return value.kind;
  }
}

export function typesEqual(a: RuntimeType, b: RuntimeType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'list' && b.kind === 'list') return typesEqual(a.element, b.element);
  if (a.kind === 'decimal' && b.kind === 'decimal') {
    return a.intDigits === b.intDigits && a.fracDigits === b.fracDigits;
  }
  return true;
}

/** Infers the runtime type of a value, e.g. for `var x = ...` without an annotation. */
export function inferType(value: Value): RuntimeType {
  switch (value.kind) {
    case 'int32':
      return { kind: 'int32' };
    case 'int64':
      return { kind: 'int64' };
    case 'decimal':
      return { kind: 'decimal' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'string':
      return { kind: 'string' };
    case 'object':
      return { kind: 'object' };
    case 'null':
      return ANY_TYPE;
    case 'list': {
      let element: RuntimeType | undefined;
      for (const item of value.elements) {
        const itemType = inferType(item);
        if (element === undefined) {
          element = itemType;
        } else if (!typesEqual(element, itemType)) {
          element = ANY_TYPE;
          break;
        }
      }
      return { kind: 'list', element: element ?? ANY_TYPE };
    }
    case 'resource':
      throw new RuntimeError('A resource reference cannot be used as a value');
  }
}

function assignError(value: Value, type: RuntimeType, context: string, line?: number): RuntimeError {
  return new RuntimeError(
    `Cannot use a ${valueTypeName(value)} value as ${typeToString(type)} ${context}`,
    line,
  );
}

/**
 * Checks a value against a type, applying the allowed numeric promotions
 * (int -> wider int, int -> decimal). Returns the possibly-converted value.
 * `null` is assignable to every type.
 */
export function coerce(value: Value, type: RuntimeType, context: string, line?: number): Value {
  if (type.kind === 'any') return value;
  if (value.kind === 'null') return value;

  switch (type.kind) {
    case 'int32': {
      if (value.kind === 'int32') return value;
      if (value.kind === 'int64') {
        if (value.value < INT32_MIN || value.value > INT32_MAX) {
          throw new RuntimeError(`Value ${value.value} is out of range for int32 ${context}`, line);
        }
        return int32Value(Number(value.value));
      }
      throw assignError(value, type, context, line);
    }
    case 'int64': {
      if (value.kind === 'int64') return value;
      if (value.kind === 'int32') return int64Value(BigInt(value.value));
      throw assignError(value, type, context, line);
    }
    case 'decimal': {
      let decimal: Decimal;
      if (value.kind === 'decimal') decimal = value.value;
      else if (value.kind === 'int32') decimal = Decimal.fromBigInt(BigInt(value.value));
      else if (value.kind === 'int64') decimal = Decimal.fromBigInt(value.value);
      else throw assignError(value, type, context, line);

      if (type.intDigits !== undefined && decimal.integerDigits() > type.intDigits) {
        throw new RuntimeError(
          `Value ${decimal.toString()} has more than ${type.intDigits} digits before the decimal point ${context}`,
          line,
        );
      }
      if (type.fracDigits !== undefined && decimal.fractionDigits() > type.fracDigits) {
        throw new RuntimeError(
          `Value ${decimal.toString()} has more than ${type.fracDigits} digits after the decimal point ${context}`,
          line,
        );
      }
      return decimalValue(decimal);
    }
    case 'boolean':
      if (value.kind === 'boolean') return value;
      throw assignError(value, type, context, line);
    case 'string':
      if (value.kind === 'string') return value;
      throw assignError(value, type, context, line);
    case 'object':
      if (value.kind === 'object') return value;
      throw assignError(value, type, context, line);
    case 'list': {
      if (value.kind !== 'list') throw assignError(value, type, context, line);
      return listValue(value.elements.map((element) => coerce(element, type.element, context, line)));
    }
  }
}

/** Renders a value for string interpolation. */
export function displayString(value: Value): string {
  switch (value.kind) {
    case 'string':
      return value.value;
    case 'int32':
      return String(value.value);
    case 'int64':
      return value.value.toString();
    case 'decimal':
      return value.value.toString();
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'list':
    case 'object':
      return JSON.stringify(valueToJson(value));
    case 'resource':
      throw new RuntimeError('A resource reference cannot be converted to a string');
  }
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Encodes a runtime value as a JSON-compatible value.
 *
 * int64 and decimal values that cannot round-trip through a JSON number
 * losslessly are encoded as strings instead.
 */
export function valueToJson(value: Value): unknown {
  switch (value.kind) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
    case 'int32':
      return value.value;
    case 'int64': {
      if (value.value >= -MAX_SAFE_BIGINT && value.value <= MAX_SAFE_BIGINT) {
        return Number(value.value);
      }
      return value.value.toString();
    }
    case 'decimal': {
      const canonical = value.value.trimmed().toString();
      const asNumber = Number(canonical);
      return String(asNumber) === canonical ? asNumber : canonical;
    }
    case 'list':
      return value.elements.map(valueToJson);
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of value.entries) result[key] = valueToJson(entry);
      return result;
    }
    case 'resource':
      throw new RuntimeError('A resource reference cannot be returned or encoded');
  }
}

class Converter {
  constructor(private readonly errorClass: typeof RuntimeError) {}

  private fail(message: string): never {
    throw new this.errorClass(message);
  }

  /**
   * Converts a host/JSON value to a runtime value of the given type.
   * Accepts JSON values plus host-side bigint and Decimal instances.
   */
  convert(raw: unknown, type: RuntimeType, context: string): Value {
    if (raw === null || raw === undefined) return NULL_VALUE;

    switch (type.kind) {
      case 'any':
        return this.infer(raw, context);
      case 'int32': {
        const int = this.toBigInt(raw, 'int32', context);
        if (int < INT32_MIN || int > INT32_MAX) {
          this.fail(`Value ${int} is out of range for int32 ${context}`);
        }
        return int32Value(Number(int));
      }
      case 'int64': {
        const int = this.toBigInt(raw, 'int64', context);
        if (int < INT64_MIN || int > INT64_MAX) {
          this.fail(`Value ${int} is out of range for int64 ${context}`);
        }
        return int64Value(int);
      }
      case 'decimal': {
        const decimal = this.toDecimal(raw, context);
        if (type.intDigits !== undefined && decimal.integerDigits() > type.intDigits) {
          this.fail(
            `Value ${decimal.toString()} has more than ${type.intDigits} digits before the decimal point ${context}`,
          );
        }
        if (type.fracDigits !== undefined && decimal.fractionDigits() > type.fracDigits) {
          this.fail(
            `Value ${decimal.toString()} has more than ${type.fracDigits} digits after the decimal point ${context}`,
          );
        }
        return decimalValue(decimal);
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') this.fail(`Expected a boolean ${context}, got ${describeRaw(raw)}`);
        return booleanValue(raw);
      }
      case 'string': {
        if (typeof raw !== 'string') this.fail(`Expected a string ${context}, got ${describeRaw(raw)}`);
        return stringValue(raw);
      }
      case 'object': {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          this.fail(`Expected an object ${context}, got ${describeRaw(raw)}`);
        }
        return this.toObject(raw as Record<string, unknown>, context);
      }
      case 'list': {
        if (!Array.isArray(raw)) this.fail(`Expected a list ${context}, got ${describeRaw(raw)}`);
        return listValue(raw.map((element, index) => this.convert(element, type.element, `${context}[${index}]`)));
      }
    }
  }

  private infer(raw: unknown, context: string): Value {
    if (raw === null || raw === undefined) return NULL_VALUE;
    if (typeof raw === 'boolean') return booleanValue(raw);
    if (typeof raw === 'string') return stringValue(raw);
    if (typeof raw === 'bigint') {
      if (raw < INT64_MIN || raw > INT64_MAX) this.fail(`Value ${raw} is out of range for int64 ${context}`);
      return raw >= INT32_MIN && raw <= INT32_MAX ? int32Value(Number(raw)) : int64Value(raw);
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) this.fail(`Value ${raw} is not a finite number ${context}`);
      if (Number.isSafeInteger(raw)) {
        return raw >= -2147483648 && raw <= 2147483647 ? int32Value(raw) : int64Value(BigInt(raw));
      }
      return decimalValue(Decimal.fromNumber(raw));
    }
    if (raw instanceof Decimal) return decimalValue(raw);
    if (Array.isArray(raw)) {
      return listValue(raw.map((element, index) => this.infer(element, `${context}[${index}]`)));
    }
    if (typeof raw === 'object') return this.toObject(raw as Record<string, unknown>, context);
    this.fail(`Unsupported value ${describeRaw(raw)} ${context}`);
  }

  private toObject(raw: Record<string, unknown>, context: string): Value {
    const entries = new Map<string, Value>();
    for (const [key, entry] of Object.entries(raw)) {
      entries.set(key, this.infer(entry, `${context}.${key}`));
    }
    return objectValue(entries);
  }

  private toBigInt(raw: unknown, typeName: string, context: string): bigint {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw)) this.fail(`Expected an integer ${typeName} ${context}, got ${raw}`);
      if (!Number.isSafeInteger(raw)) {
        this.fail(`Number ${raw} ${context} exceeds safe integer precision; pass it as a string`);
      }
      return BigInt(raw);
    }
    if (typeof raw === 'string') {
      if (!/^-?\d+$/.test(raw.trim())) this.fail(`Expected an integer ${typeName} ${context}, got '${raw}'`);
      return BigInt(raw.trim());
    }
    this.fail(`Expected an integer ${typeName} ${context}, got ${describeRaw(raw)}`);
  }

  private toDecimal(raw: unknown, context: string): Decimal {
    try {
      if (raw instanceof Decimal) return raw;
      if (typeof raw === 'bigint') return Decimal.fromBigInt(raw);
      if (typeof raw === 'number') return Decimal.fromNumber(raw);
      if (typeof raw === 'string') return Decimal.fromString(raw);
    } catch (error) {
      if (error instanceof DecimalArithmeticError) this.fail(`${error.message} ${context}`);
      throw error;
    }
    this.fail(`Expected a decimal ${context}, got ${describeRaw(raw)}`);
  }
}

function describeRaw(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'a list';
  if (raw instanceof Decimal) return 'a decimal';
  const type = typeof raw;
  if (type === 'object') return 'an object';
  return `${type === 'undefined' ? 'undefined' : `a ${type}`}`;
}

/** Converts an incoming contract parameter (JSON) to a runtime value; failures are ParameterErrors. */
export function parameterToValue(raw: unknown, type: RuntimeType, context: string): Value {
  return new Converter(ParameterError).convert(raw, type, context);
}

/** Converts a host value (e.g. a resource function's return) to a runtime value. */
export function hostToValue(raw: unknown, type: RuntimeType, context: string): Value {
  return new Converter(RuntimeError).convert(raw, type, context);
}

/**
 * Converts a runtime value to a plain host value for resource function calls:
 * int32 -> number, int64 -> bigint, decimal -> Decimal, lists/objects -> plain
 * arrays/objects of host values.
 */
export function valueToHost(value: Value): unknown {
  switch (value.kind) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
    case 'int32':
    case 'int64':
      return value.value;
    case 'decimal':
      return value.value;
    case 'list':
      return value.elements.map(valueToHost);
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of value.entries) result[key] = valueToHost(entry);
      return result;
    }
    case 'resource':
      throw new RuntimeError('A resource reference cannot be passed to a resource function');
  }
}
