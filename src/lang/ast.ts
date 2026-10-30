/** Abstract syntax tree for Requestscript. */

// ---------- Types ----------

export type TypeNode =
  | { kind: 'int32' }
  | { kind: 'int64' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'object' }
  | { kind: 'decimal'; intDigits?: number; fracDigits?: number }
  | { kind: 'list'; element: TypeNode };

export interface ParameterDecl {
  name: string;
  type: TypeNode;
}

// ---------- Script / declarations ----------

export interface RequestDecl {
  kind: 'request';
  name: string;
}

export interface ContractDecl {
  kind: 'contract';
  /** Dotted path segments preceding the name; empty for a path-less contract. */
  path: string[];
  name: string;
  /** Declared with '@<version>' after the name — dot-separated numbers such as '2' or '1.2.3'; '1' when omitted. */
  version: string;
  parameters: ParameterDecl[];
  /** Declared with ': type' after the parameters. The contract's return value is checked against it. */
  returnType?: TypeNode;
}

export type Declaration = RequestDecl | ContractDecl;

export interface Script {
  declaration: Declaration;
  body: Statement[];
}

// ---------- Statements ----------

// Every statement and expression carries `tokens`: the number of lexer tokens
// it owns, excluding the tokens owned by its child nodes, so summing `tokens`
// over a set of nodes never counts a token twice. Tokens outside any node (the
// declaration, its parameter list and the body's braces) are owned by none.
// Script metering charges a node's `tokens` when the node executes.

export interface VarDeclStatement {
  kind: 'varDecl';
  constant: boolean;
  name: string;
  type?: TypeNode;
  value: Expression;
  /**
   * Set for `var state name = ...` or `var state(scope) name = ...` at the top level of a contract: a value
   * the host keeps between invocations, one per value of `scope` when it has one.
   */
  state?: { scope?: Expression };
  line: number;
  tokens: number;
}

/** `const name: dotted.path.ResourceName` — binds a host resource. */
export interface ResourceDeclStatement {
  kind: 'resourceDecl';
  name: string;
  resourcePath: string[];
  resourceName: string;
  line: number;
  tokens: number;
}

export interface AssignStatement {
  kind: 'assign';
  target: IdentifierExpr | MemberExpr | IndexExpr;
  value: Expression;
  line: number;
  tokens: number;
}

export interface ReturnStatement {
  kind: 'return';
  value?: Expression;
  line: number;
  tokens: number;
}

export interface IfBranch {
  condition: Expression;
  body: Statement[];
  /** The branch's own tokens: `if` or `else if`, the condition's parentheses and the body's braces. */
  tokens: number;
}

/** An if statement owns no tokens itself (`tokens` is 0); its branches and `else` own them. */
export interface IfStatement {
  kind: 'if';
  branches: IfBranch[];
  elseBody?: Statement[];
  /** The `else` keyword and the else body's braces, when there is an else body. */
  elseTokens?: number;
  line: number;
  tokens: number;
}

export interface ExpressionStatement {
  kind: 'exprStmt';
  expression: Expression;
  line: number;
  tokens: number;
}

export type Statement =
  | VarDeclStatement
  | ResourceDeclStatement
  | AssignStatement
  | ReturnStatement
  | IfStatement
  | ExpressionStatement;

// ---------- Expressions ----------

export interface IntLiteralExpr {
  kind: 'intLiteral';
  value: bigint;
  line: number;
  tokens: number;
}

export interface DecimalLiteralExpr {
  kind: 'decimalLiteral';
  raw: string;
  line: number;
  tokens: number;
}

export interface BooleanLiteralExpr {
  kind: 'booleanLiteral';
  value: boolean;
  line: number;
  tokens: number;
}

export interface NullLiteralExpr {
  kind: 'nullLiteral';
  line: number;
  tokens: number;
}

export interface StringLiteralExpr {
  kind: 'stringLiteral';
  value: string;
  line: number;
  tokens: number;
}

export type TemplatePart = { type: 'text'; value: string } | { type: 'expr'; expression: Expression };

/** A string literal containing `${...}` interpolations. */
export interface TemplateStringExpr {
  kind: 'templateString';
  parts: TemplatePart[];
  line: number;
  tokens: number;
}

export interface ObjectLiteralExpr {
  kind: 'objectLiteral';
  entries: { key: string; value: Expression }[];
  line: number;
  tokens: number;
}

export interface ListLiteralExpr {
  kind: 'listLiteral';
  elements: Expression[];
  line: number;
  tokens: number;
}

export interface IdentifierExpr {
  kind: 'identifier';
  name: string;
  line: number;
  tokens: number;
}

export interface MemberExpr {
  kind: 'member';
  object: Expression;
  property: string;
  line: number;
  tokens: number;
}

export interface IndexExpr {
  kind: 'index';
  object: Expression;
  index: Expression;
  line: number;
  tokens: number;
}

export interface NamedArgument {
  name: string;
  value: Expression;
}

/** A resource function call: `resourceRef.fn(name: value, ...)`. */
export interface CallExpr {
  kind: 'call';
  callee: MemberExpr;
  args: NamedArgument[];
  line: number;
  tokens: number;
}

export type UnaryOperator = '!' | '-';

export interface UnaryExpr {
  kind: 'unary';
  operator: UnaryOperator;
  operand: Expression;
  line: number;
  tokens: number;
}

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||';

export interface BinaryExpr {
  kind: 'binary';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  line: number;
  tokens: number;
}

export type Expression =
  | IntLiteralExpr
  | DecimalLiteralExpr
  | BooleanLiteralExpr
  | NullLiteralExpr
  | StringLiteralExpr
  | TemplateStringExpr
  | ObjectLiteralExpr
  | ListLiteralExpr
  | IdentifierExpr
  | MemberExpr
  | IndexExpr
  | CallExpr
  | UnaryExpr
  | BinaryExpr;
