import type { Expression, IfStatement, Script, Statement } from './ast.js';
import { RuntimeError } from './errors.js';

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
 * The most tokens any run of the script can execute: every statement, with
 * each if statement taking its costliest path. Scripts have no loops or
 * user-defined functions, so this bound is finite and known before running.
 */
export function maxTokens(script: Script): number {
  return blockMax(script.body);
}

function blockMax(statements: Statement[]): number {
  return statements.reduce((sum, statement) => sum + statementMax(statement), 0);
}

function statementMax(statement: Statement): number {
  switch (statement.kind) {
    case 'varDecl':
      // A state variable's initializer runs only when nothing is stored yet, but may run.
      return statement.tokens + expressionMax(statement.value) + (statement.state?.scope ? expressionMax(statement.state.scope) : 0);
    case 'resourceDecl':
      return statement.tokens;
    case 'assign':
      return statement.tokens + expressionMax(statement.target) + expressionMax(statement.value);
    case 'return':
      return statement.tokens + (statement.value ? expressionMax(statement.value) : 0);
    case 'if':
      return ifMax(statement);
    case 'exprStmt':
      return statement.tokens + expressionMax(statement.expression);
  }
}

/** Taking a branch costs every condition up to and including its own, plus its body. */
function ifMax(statement: IfStatement): number {
  let conditions = 0;
  let max = 0;
  for (const branch of statement.branches) {
    conditions += branch.tokens + expressionMax(branch.condition);
    max = Math.max(max, conditions + blockMax(branch.body));
  }
  const elseCost = statement.elseBody ? (statement.elseTokens ?? 0) + blockMax(statement.elseBody) : 0;
  return Math.max(max, conditions + elseCost);
}

function expressionMax(expression: Expression): number {
  return expression.tokens + childExpressions(expression).reduce((sum, child) => sum + expressionMax(child), 0);
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
    case 'call':
      return [expression.callee, ...expression.args.map((arg) => arg.value)];
    case 'unary':
      return [expression.operand];
    case 'binary':
      return [expression.left, expression.right];
    default:
      return [];
  }
}
