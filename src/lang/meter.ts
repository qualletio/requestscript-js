import type { Expression, FunctionDecl, IfStatement, Script, Statement } from './ast.js';
import { EntrypointError, RuntimeError } from './errors.js';
import { entrypoints } from './functions.js';

/** Thrown when executing a node would take a script past its meter's token limit. */
export class TokenLimitError extends RuntimeError {}

/**
 * Counts the tokens a script executes. The interpreter charges each node's
 * `tokens` just before running it; a node that would pass `limit` is not run
 * or counted, so `tokens` never exceeds `limit`.
 */
export class TokenMeter {
  private count = 0;

  constructor(readonly limit?: number) {}

  get tokens(): number {
    return this.count;
  }

  charge(tokens: number, line?: number): void {
    if (this.limit !== undefined && this.count + tokens > this.limit) {
      throw new TokenLimitError(`The script exceeded its limit of ${this.limit} tokens`, line);
    }
    this.count += tokens;
  }
}

/**
 * The most tokens any run of the script can execute: every statement, with each if statement taking its
 * costliest path, and each call to a contract function costing its arguments and the most its body can. For a
 * contract, a run is its top-level declarations and then the entrypoint `functionName` (a `pub` function, or
 * an event contract's `on`); without one, it is the costliest entrypoint. Scripts have no loops, and a
 * contract's functions never lead back to themselves, so this bound is finite and known before running.
 */
export function maxTokens(script: Script, functionName?: string): number {
  const costs = new FunctionCosts(script.functions);
  const top = costs.block(script.body);
  if (script.declaration.kind !== 'contract') return top;
  if (functionName !== undefined) {
    const fn = entrypoints(script).find((candidate) => candidate.name === functionName);
    if (!fn) throw new EntrypointError(`The contract has no entrypoint '${functionName}'`);
    return top + costs.function(fn);
  }
  return top + Math.max(0, ...entrypoints(script).map((fn) => costs.function(fn)));
}

class FunctionCosts {
  private readonly byName: Map<string, FunctionDecl>;
  private readonly memo = new Map<string, number>();

  constructor(functions: FunctionDecl[]) {
    this.byName = new Map(functions.map((fn) => [fn.name, fn]));
  }

  function(fn: FunctionDecl): number {
    let cost = this.memo.get(fn.name);
    if (cost === undefined) {
      cost = this.block(fn.body);
      this.memo.set(fn.name, cost);
    }
    return cost;
  }

  block(statements: Statement[]): number {
    return statements.reduce((sum, statement) => sum + this.statement(statement), 0);
  }

  private statement(statement: Statement): number {
    switch (statement.kind) {
      case 'varDecl':
        // A state variable's initializer runs only when nothing is stored yet, but may run.
        return statement.tokens + this.expression(statement.value) + (statement.state?.scope ? this.expression(statement.state.scope) : 0);
      case 'resourceDecl':
        return statement.tokens;
      case 'assign':
        return statement.tokens + this.expression(statement.target) + this.expression(statement.value);
      case 'return':
        return statement.tokens + (statement.value ? this.expression(statement.value) : 0);
      case 'if':
        return this.if(statement);
      case 'exprStmt':
        return statement.tokens + this.expression(statement.expression);
      case 'emit':
        return statement.tokens + statement.args.reduce((sum, arg) => sum + this.expression(arg.value), 0);
      case 'fail':
        return statement.tokens + this.expression(statement.message);
    }
  }

  /** Taking a branch costs every condition up to and including its own, plus its body. */
  private if(statement: IfStatement): number {
    let conditions = 0;
    let max = 0;
    for (const branch of statement.branches) {
      conditions += branch.tokens + this.expression(branch.condition);
      max = Math.max(max, conditions + this.block(branch.body));
    }
    const elseCost = statement.elseBody ? (statement.elseTokens ?? 0) + this.block(statement.elseBody) : 0;
    return Math.max(max, conditions + elseCost);
  }

  private expression(expression: Expression): number {
    const own = expression.tokens + childExpressions(expression).reduce((sum, child) => sum + this.expression(child), 0);
    if (expression.kind !== 'fnCall') return own;
    const fn = this.byName.get(expression.name);
    return own + (fn ? this.function(fn) : 0);
  }
}
function childExpressions(expression: Expression): Expression[] {
  switch (expression.kind) {
    case 'templateString':
      return expression.parts.flatMap((part) => (part.type === 'expr' ? [part.expression] : []));
    case 'objectLiteral':
      return expression.entries.map((entry) => entry.value);
    case 'listLiteral':
      return expression.elements;
    case 'member':
      return [expression.object];
    case 'index':
      return [expression.object, expression.index];
    case 'call': {
      const options = expression.options;
      const optionValues = options ? [options.amount, options.payees, options.from, options.key].filter((value): value is Expression => value !== undefined) : [];
      return [expression.callee, ...optionValues, ...expression.args.map((arg) => arg.value)];
    }
    case 'fnCall':
      return expression.args.map((arg) => arg.value);
    case 'unary':
      return [expression.operand];
    case 'binary':
      return [expression.left, expression.right];
    default:
      return [];
  }
}
