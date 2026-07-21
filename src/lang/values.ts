import type { Decimal } from './decimal.js';
import type { Resource } from './resource.js';

export const INT32_MIN = -2147483648n;
export const INT32_MAX = 2147483647n;
export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

/** Runtime values flowing through the interpreter. */
export type Value =
  | { kind: 'int32'; value: number }
  | { kind: 'int64'; value: bigint }
  | { kind: 'decimal'; value: Decimal }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; elements: Value[] }
  | { kind: 'object'; entries: Map<string, Value> }
  | { kind: 'resource'; resource: Resource };

export const NULL_VALUE: Value = { kind: 'null' };

export function int32Value(value: number): Value {
  return { kind: 'int32', value };
}

export function int64Value(value: bigint): Value {
  return { kind: 'int64', value };
}

export function decimalValue(value: Decimal): Value {
  return { kind: 'decimal', value };
}

export function booleanValue(value: boolean): Value {
  return { kind: 'boolean', value };
}

export function stringValue(value: string): Value {
  return { kind: 'string', value };
}

export function listValue(elements: Value[]): Value {
  return { kind: 'list', elements };
}

export function objectValue(entries: Map<string, Value>): Value {
  return { kind: 'object', entries };
}

export function isNumeric(value: Value): boolean {
  return value.kind === 'int32' || value.kind === 'int64' || value.kind === 'decimal';
}
