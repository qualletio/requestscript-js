import type {
  BinaryExpr,
  CallExpr,
  Declaration,
  Expression,
  Script,
  Statement,
} from './ast.js';
import { Decimal, DecimalArithmeticError } from './decimal.js';
import { ParameterError, RuntimeError } from './errors.js';
import { parseScript, parseTypeString } from './parser.js';
import { resourceKey, type Resource, type ResourceFunctionCallParameter } from './resource.js';
import {
  ANY_TYPE,
  coerce,
  displayString,
  hostToValue,
  inferType,
  parameterToValue,
  typeToString,
  valueToHost,
  valueToJson,
  valueTypeName,
  type RuntimeType,
} from './types.js';
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

export interface InterpretOptions {
  /** Host resources scripts may reference. */
  resources?: Resource[];
  /** Contract parameter values (as parsed JSON). */
  parameters?: Record<string, unknown>;
}

export interface InterpretResult {
  declaration: Declaration;
  /** The script's return value, already encoded as a JSON-compatible value. */
  returnValue: unknown;
}

/** Thrown internally to unwind execution when a return statement runs. */
class ReturnSignal {
  constructor(readonly value: Value) {}
}

interface Binding {
  value: Value;
  type: RuntimeType;
  constant: boolean;
}

class Environment {
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly parent?: Environment) {}

  declare(name: string, binding: Binding, line?: number): void {
    if (this.lookup(name) !== undefined) {
      throw new RuntimeError(`Variable '${name}' is already declared and cannot be redeclared`, line);
    }
    this.bindings.set(name, binding);
  }

  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }
}

function requireData(value: Value, line: number): Value {
  if (value.kind === 'resource') {
    throw new RuntimeError('A resource reference cannot be used as a value', line);
  }
  return value;
}

export class Interpreter {
  private readonly resources = new Map<string, Resource>();

  constructor(resources: Resource[] = []) {
    for (const resource of resources) {
      this.resources.set(resourceKey(resource.path, resource.name), resource);
    }
  }

  async run(script: Script, parameters?: Record<string, unknown>): Promise<InterpretResult> {
    const root = new Environment();
    this.bindParameters(script.declaration, parameters, root);

    let result: Value = NULL_VALUE;
    try {
      await this.execStatements(script.body, root);
    } catch (error) {
      if (error instanceof ReturnSignal) {
        result = error.value;
      } else {
        throw error;
      }
    }
    return { declaration: script.declaration, returnValue: valueToJson(result) };
  }

  private bindParameters(
    declaration: Declaration,
    parameters: Record<string, unknown> | undefined,
    env: Environment,
  ): void {
    if (declaration.kind === 'request') {
      if (parameters !== undefined && Object.keys(parameters).length > 0) {
        throw new ParameterError('A request script does not take parameters');
      }
      return;
    }

    const provided = parameters ?? {};
    const declared = new Set(declaration.parameters.map((parameter) => parameter.name));
    for (const key of Object.keys(provided)) {
      if (!declared.has(key)) throw new ParameterError(`Unknown parameter '${key}'`);
    }
    for (const parameter of declaration.parameters) {
      if (!(parameter.name in provided)) {
        throw new ParameterError(`Missing parameter '${parameter.name}'`);
      }
      const value = parameterToValue(provided[parameter.name], parameter.type, `for parameter '${parameter.name}'`);
      env.declare(parameter.name, { value, type: parameter.type, constant: true });
    }
  }

  // ---------- statements ----------

  private async execStatements(statements: Statement[], env: Environment): Promise<void> {
    for (const statement of statements) {
      await this.execStatement(statement, env);
    }
  }

  private async execStatement(statement: Statement, env: Environment): Promise<void> {
    switch (statement.kind) {
      case 'varDecl': {
        const raw = await this.evaluate(statement.value, env);
        const value = requireData(raw, statement.line);
        const type: RuntimeType = statement.type ?? inferType(value);
        const coerced = statement.type
          ? coerce(value, statement.type, `in the declaration of '${statement.name}'`, statement.line)
          : value;
        env.declare(statement.name, { value: coerced, type, constant: statement.constant }, statement.line);
        return;
      }
      case 'resourceDecl': {
        const path = statement.resourcePath.join('.');
        const key = resourceKey(path, statement.resourceName);
        const resource = this.resources.get(key);
        if (!resource) {
          throw new RuntimeError(`Unknown resource '${key}'`, statement.line);
        }
        env.declare(statement.name, { value: { kind: 'resource', resource }, type: ANY_TYPE, constant: true }, statement.line);
        return;
      }
      case 'assign':
        return this.execAssign(statement.target, statement.value, statement.line, env);
      case 'return': {
        const value = statement.value
          ? requireData(await this.evaluate(statement.value, env), statement.line)
          : NULL_VALUE;
        throw new ReturnSignal(value);
      }
      case 'if': {
        for (const branch of statement.branches) {
          const condition = await this.evaluate(branch.condition, env);
          if (condition.kind !== 'boolean') {
            throw new RuntimeError(
              `An if condition must be a boolean, got ${valueTypeName(condition)}`,
              statement.line,
            );
          }
          if (condition.value) {
            return this.execStatements(branch.body, new Environment(env));
          }
        }
        if (statement.elseBody) {
          return this.execStatements(statement.elseBody, new Environment(env));
        }
        return;
      }
      case 'exprStmt':
        await this.evaluate(statement.expression, env);
        return;
    }
  }

  private async execAssign(
    target: Extract<Expression, { kind: 'identifier' | 'member' | 'index' }>,
    valueExpr: Expression,
    line: number,
    env: Environment,
  ): Promise<void> {
    const value = requireData(await this.evaluate(valueExpr, env), line);

    switch (target.kind) {
      case 'identifier': {
        const binding = env.lookup(target.name);
        if (!binding) throw new RuntimeError(`Unknown variable '${target.name}'`, line);
        if (binding.constant) {
          throw new RuntimeError(`Cannot assign to '${target.name}' because it is a const`, line);
        }
        binding.value = coerce(value, binding.type, `in assignment to '${target.name}'`, line);
        return;
      }
      case 'member': {
        const object = await this.evaluate(target.object, env);
        if (object.kind !== 'object') {
          throw new RuntimeError(
            `Cannot set property '${target.property}' of ${valueTypeName(object)}`,
            line,
          );
        }
        object.entries.set(target.property, value);
        return;
      }
      case 'index': {
        const object = await this.evaluate(target.object, env);
        const index = await this.evaluate(target.index, env);
        if (object.kind !== 'list') {
          throw new RuntimeError(`Cannot index into ${valueTypeName(object)}`, line);
        }
        const i = this.indexNumber(index, object.elements.length, line);
        object.elements[i] = value;
        return;
      }
    }
  }

  private indexNumber(index: Value, length: number, line: number): number {
    if (index.kind !== 'int32' && index.kind !== 'int64') {
      throw new RuntimeError(`A list index must be an integer, got ${valueTypeName(index)}`, line);
    }
    const i = Number(index.value);
    if (i < 0 || i >= length) {
      throw new RuntimeError(`List index ${i} is out of bounds (list has ${length} items)`, line);
    }
    return i;
  }

  // ---------- expressions ----------

  private async evaluate(expression: Expression, env: Environment): Promise<Value> {
    switch (expression.kind) {
      case 'intLiteral': {
        const value = expression.value;
        if (value >= INT32_MIN && value <= INT32_MAX) return int32Value(Number(value));
        if (value >= INT64_MIN && value <= INT64_MAX) return int64Value(value);
        throw new RuntimeError(`Integer literal ${value} is out of range for int64`, expression.line);
      }
      case 'decimalLiteral':
        return decimalValue(Decimal.fromString(expression.raw));
      case 'booleanLiteral':
        return booleanValue(expression.value);
      case 'stringLiteral':
        return stringValue(expression.value);
      case 'nullLiteral':
        return NULL_VALUE;
      case 'templateString': {
        let result = '';
        for (const part of expression.parts) {
          if (part.type === 'text') {
            result += part.value;
          } else {
            const value = await this.evaluate(part.expression, env);
            try {
              result += displayString(value);
            } catch (error) {
              if (error instanceof RuntimeError) {
                throw new RuntimeError(error.message, expression.line);
              }
              throw error;
            }
          }
        }
        return stringValue(result);
      }
      case 'objectLiteral': {
        const entries = new Map<string, Value>();
        for (const entry of expression.entries) {
          entries.set(entry.key, requireData(await this.evaluate(entry.value, env), expression.line));
        }
        return objectValue(entries);
      }
      case 'listLiteral': {
        const elements: Value[] = [];
        for (const element of expression.elements) {
          elements.push(requireData(await this.evaluate(element, env), expression.line));
        }
        return listValue(elements);
      }
      case 'identifier': {
        const binding = env.lookup(expression.name);
        if (!binding) throw new RuntimeError(`Unknown variable '${expression.name}'`, expression.line);
        return binding.value;
      }
      case 'member': {
        const object = await this.evaluate(expression.object, env);
        if (object.kind === 'object') {
          return object.entries.get(expression.property) ?? NULL_VALUE;
        }
        if (object.kind === 'resource') {
          throw new RuntimeError(
            `Resource function '${expression.property}' must be called with parentheses`,
            expression.line,
          );
        }
        throw new RuntimeError(
          `Cannot access property '${expression.property}' of ${valueTypeName(object)}`,
          expression.line,
        );
      }
      case 'index': {
        const object = await this.evaluate(expression.object, env);
        if (object.kind !== 'list') {
          throw new RuntimeError(`Cannot index into ${valueTypeName(object)}`, expression.line);
        }
        const index = await this.evaluate(expression.index, env);
        return object.elements[this.indexNumber(index, object.elements.length, expression.line)]!;
      }
      case 'call':
        return this.evalCall(expression, env);
      case 'unary': {
        const operand = await this.evaluate(expression.operand, env);
        if (expression.operator === '!') {
          if (operand.kind !== 'boolean') {
            throw new RuntimeError(`Operator '!' requires a boolean, got ${valueTypeName(operand)}`, expression.line);
          }
          return booleanValue(!operand.value);
        }
        // Unary minus
        switch (operand.kind) {
          case 'int32':
            return this.intResult(-BigInt(operand.value), false, expression.line);
          case 'int64':
            return this.intResult(-operand.value, true, expression.line);
          case 'decimal':
            return decimalValue(operand.value.negate());
          default:
            throw new RuntimeError(`Operator '-' requires a number, got ${valueTypeName(operand)}`, expression.line);
        }
      }
      case 'binary':
        return this.evalBinary(expression, env);
    }
  }

  private async evalCall(expression: CallExpr, env: Environment): Promise<Value> {
    const target = await this.evaluate(expression.callee.object, env);
    if (target.kind !== 'resource') {
      throw new RuntimeError(`Cannot call '${expression.callee.property}' on ${valueTypeName(target)}`, expression.line);
    }
    const resource = target.resource;
    const fn = resource.functions.find((candidate) => candidate.name === expression.callee.property);
    if (!fn) {
      throw new RuntimeError(
        `Resource '${resourceKey(resource.path, resource.name)}' has no function '${expression.callee.property}'`,
        expression.line,
      );
    }

    const declared = new Map(fn.parameters.map((parameter) => [parameter.name, parameter]));
    for (const arg of expression.args) {
      if (!declared.has(arg.name)) {
        throw new RuntimeError(`Function '${fn.name}' has no parameter '${arg.name}'`, expression.line);
      }
    }
    const byName = new Map(expression.args.map((arg) => [arg.name, arg.value]));

    const callParameters: ResourceFunctionCallParameter[] = [];
    for (const parameter of fn.parameters) {
      const argExpr = byName.get(parameter.name);
      if (argExpr === undefined) {
        throw new RuntimeError(`Missing argument '${parameter.name}' for function '${fn.name}'`, expression.line);
      }
      const type = this.resourceType(parameter.type, `parameter '${parameter.name}' of function '${fn.name}'`, expression.line);
      const value = requireData(await this.evaluate(argExpr, env), expression.line);
      const coerced = coerce(value, type, `for argument '${parameter.name}' of '${fn.name}'`, expression.line);
      callParameters.push({ name: parameter.name, value: valueToHost(coerced) });
    }

    let result: unknown;
    try {
      result = await fn.exec(callParameters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RuntimeError(`Resource function '${fn.name}' failed: ${message}`, expression.line);
    }

    if (fn.returnType === 'void') return NULL_VALUE;
    const returnType = this.resourceType(fn.returnType, `return type of function '${fn.name}'`, expression.line);
    return hostToValue(result, returnType, `returned from '${fn.name}'`);
  }

  private resourceType(type: string, what: string, line: number): RuntimeType {
    try {
      return parseTypeString(type);
    } catch {
      throw new RuntimeError(`Resource declares an invalid type '${type}' for ${what}`, line);
    }
  }

  // ---------- operators ----------

  private async evalBinary(expression: BinaryExpr, env: Environment): Promise<Value> {
    const { operator, line } = expression;

    if (operator === '&&' || operator === '||') {
      const left = await this.evaluate(expression.left, env);
      if (left.kind !== 'boolean') {
        throw new RuntimeError(`Operator '${operator}' requires booleans, got ${valueTypeName(left)}`, line);
      }
      if (operator === '&&' && !left.value) return booleanValue(false);
      if (operator === '||' && left.value) return booleanValue(true);
      const right = await this.evaluate(expression.right, env);
      if (right.kind !== 'boolean') {
        throw new RuntimeError(`Operator '${operator}' requires booleans, got ${valueTypeName(right)}`, line);
      }
      return booleanValue(right.value);
    }

    const left = await this.evaluate(expression.left, env);
    const right = await this.evaluate(expression.right, env);

    switch (operator) {
      case '==':
        return booleanValue(valuesEqual(left, right));
      case '!=':
        return booleanValue(!valuesEqual(left, right));
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const comparison = this.compareValues(left, right, operator, line);
        switch (operator) {
          case '<':
            return booleanValue(comparison < 0);
          case '<=':
            return booleanValue(comparison <= 0);
          case '>':
            return booleanValue(comparison > 0);
          case '>=':
            return booleanValue(comparison >= 0);
        }
        break;
      }
      case '+':
        if (left.kind === 'string' || right.kind === 'string') {
          return stringValue(displayString(left) + displayString(right));
        }
        return this.arithmetic(left, right, '+', line);
      case '-':
      case '*':
      case '/':
        return this.arithmetic(left, right, operator, line);
    }
    throw new RuntimeError(`Unsupported operator '${operator}'`, line);
  }

  private compareValues(left: Value, right: Value, operator: string, line: number): number {
    if (left.kind === 'string' && right.kind === 'string') {
      return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
    }
    const isInt = (v: Value) => v.kind === 'int32' || v.kind === 'int64';
    if (isInt(left) && isInt(right)) {
      const a = BigInt((left as { value: number | bigint }).value);
      const b = BigInt((right as { value: number | bigint }).value);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    const a = toDecimalOperand(left);
    const b = toDecimalOperand(right);
    if (a && b) return a.compare(b);
    throw new RuntimeError(
      `Operator '${operator}' cannot compare ${valueTypeName(left)} and ${valueTypeName(right)}`,
      line,
    );
  }

  private arithmetic(left: Value, right: Value, operator: '+' | '-' | '*' | '/', line: number): Value {
    if (left.kind === 'decimal' || right.kind === 'decimal') {
      const a = toDecimalOperand(left);
      const b = toDecimalOperand(right);
      if (!a || !b) {
        throw new RuntimeError(
          `Operator '${operator}' cannot be applied to ${valueTypeName(left)} and ${valueTypeName(right)}`,
          line,
        );
      }
      try {
        switch (operator) {
          case '+':
            return decimalValue(a.add(b));
          case '-':
            return decimalValue(a.subtract(b));
          case '*':
            return decimalValue(a.multiply(b));
          case '/':
            return decimalValue(a.divide(b));
        }
      } catch (error) {
        if (error instanceof DecimalArithmeticError) throw new RuntimeError(error.message, line);
        throw error;
      }
    }

    const isInt = (v: Value) => v.kind === 'int32' || v.kind === 'int64';
    if (!isInt(left) || !isInt(right)) {
      throw new RuntimeError(
        `Operator '${operator}' cannot be applied to ${valueTypeName(left)} and ${valueTypeName(right)}`,
        line,
      );
    }
    const a = BigInt((left as { value: number | bigint }).value);
    const b = BigInt((right as { value: number | bigint }).value);
    const wide = left.kind === 'int64' || right.kind === 'int64';

    let result: bigint;
    switch (operator) {
      case '+':
        result = a + b;
        break;
      case '-':
        result = a - b;
        break;
      case '*':
        result = a * b;
        break;
      case '/':
        if (b === 0n) throw new RuntimeError('Division by zero', line);
        result = a / b; // integer division truncates toward zero
        break;
    }
    return this.intResult(result, wide, line);
  }

  private intResult(value: bigint, wide: boolean, line: number): Value {
    if (!wide) {
      if (value < INT32_MIN || value > INT32_MAX) {
        throw new RuntimeError(`int32 overflow: ${value}`, line);
      }
      return int32Value(Number(value));
    }
    if (value < INT64_MIN || value > INT64_MAX) {
      throw new RuntimeError(`int64 overflow: ${value}`, line);
    }
    return int64Value(value);
  }
}

function toDecimalOperand(value: Value): Decimal | undefined {
  switch (value.kind) {
    case 'decimal':
      return value.value;
    case 'int32':
      return Decimal.fromBigInt(BigInt(value.value));
    case 'int64':
      return Decimal.fromBigInt(value.value);
    default:
      return undefined;
  }
}

/** Deep structural equality; numeric values compare by numeric value across kinds. */
export function valuesEqual(a: Value, b: Value): boolean {
  const aDecimal = toDecimalOperand(a);
  const bDecimal = toDecimalOperand(b);
  if (aDecimal && bDecimal) return aDecimal.equals(bDecimal);

  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'null':
      return true;
    case 'boolean':
    case 'string':
      return a.value === (b as typeof a).value;
    case 'list': {
      const other = b as typeof a;
      return (
        a.elements.length === other.elements.length &&
        a.elements.every((element, index) => valuesEqual(element, other.elements[index]!))
      );
    }
    case 'object': {
      const other = b as typeof a;
      if (a.entries.size !== other.entries.size) return false;
      for (const [key, value] of a.entries) {
        const otherValue = other.entries.get(key);
        if (otherValue === undefined || !valuesEqual(value, otherValue)) return false;
      }
      return true;
    }
    case 'resource':
      return a.resource === (b as typeof a).resource;
    default:
      return false;
  }
}

/** Parses and executes a script in one call. */
export async function interpret(source: string, options: InterpretOptions = {}): Promise<InterpretResult> {
  const script = parseScript(source);
  return interpretParsed(script, options);
}

/** Executes an already-parsed script. */
export async function interpretParsed(script: Script, options: InterpretOptions = {}): Promise<InterpretResult> {
  const interpreter = new Interpreter(options.resources ?? []);
  return interpreter.run(script, options.parameters);
}
