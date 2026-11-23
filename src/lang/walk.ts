import type { Expression, LambdaExpr, Statement } from './ast.js';

/**
 * The expressions directly beneath `expression`. A component's children and its lambdas' bodies are statements,
 * not expressions, so they aren't included: see `nestedBlocks`.
 */
export function childExpressions(expression: Expression): Expression[] {
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
    case 'view':
      return expression.args.flatMap((arg) => ('value' in arg ? [arg.value] : []));
    default:
      return [];
  }
}

/** The lambdas written as `expression`'s own arguments. */
export function lambdasOf(expression: Expression): LambdaExpr[] {
  return expression.kind === 'view' ? expression.args.flatMap((arg) => ('lambda' in arg ? [arg.lambda] : [])) : [];
}

/** The expressions a statement holds directly. An `if`'s bodies are statements: see `statementBlocks`. */
export function statementExpressions(statement: Statement): Expression[] {
  switch (statement.kind) {
    case 'varDecl':
      return statement.state?.scope ? [statement.value, statement.state.scope] : [statement.value];
    case 'resourceDecl':
      return [];
    case 'assign':
      return [statement.target, statement.value];
    case 'return':
      return statement.value ? [statement.value] : [];
    case 'if':
      return statement.branches.map((branch) => branch.condition);
    case 'exprStmt':
      return [statement.expression];
    case 'emit':
      return statement.args.map((arg) => arg.value);
    case 'fail':
      return [statement.message];
  }
}

/** The blocks an `if` statement holds. */
export function statementBlocks(statement: Statement): Statement[][] {
  if (statement.kind !== 'if') return [];
  return [...statement.branches.map((branch) => branch.body), ...(statement.elseBody ? [statement.elseBody] : [])];
}

/**
 * Visits every expression in `statements`, at any depth: inside `if` bodies, component children, and, unless
 * `lambdas` is false, the bodies of lambdas. `inLambda` says whether the expression is in a lambda's body,
 * which runs as an action rather than where it is written.
 */
export function walkExpressions(
  statements: Statement[],
  visit: (expression: Expression, inLambda: boolean) => void,
  options: { lambdas?: boolean } = {},
): void {
  const lambdas = options.lambdas ?? true;
  const expression = (node: Expression, inLambda: boolean): void => {
    visit(node, inLambda);
    for (const child of childExpressions(node)) expression(child, inLambda);
    if (node.kind === 'view' && node.children) block(node.children, inLambda);
    if (lambdas) for (const lambda of lambdasOf(node)) block(lambda.body, true);
  };
  const block = (nodes: Statement[], inLambda: boolean): void => {
    for (const statement of nodes) {
      for (const child of statementExpressions(statement)) expression(child, inLambda);
      for (const nested of statementBlocks(statement)) block(nested, inLambda);
    }
  };
  block(statements, false);
}

/**
 * Visits every statement in `statements`, at any depth, including those in component children and lambda
 * bodies, in source order.
 */
export function walkNestedStatements(statements: Statement[], visit: (statement: Statement) => void): void {
  const fromExpression = (node: Expression): void => {
    for (const child of childExpressions(node)) fromExpression(child);
    if (node.kind === 'view' && node.children) block(node.children);
    for (const lambda of lambdasOf(node)) block(lambda.body);
  };
  const block = (nodes: Statement[]): void => {
    for (const statement of nodes) {
      visit(statement);
      for (const child of statementExpressions(statement)) fromExpression(child);
      for (const nested of statementBlocks(statement)) block(nested);
    }
  };
  block(statements);
}
