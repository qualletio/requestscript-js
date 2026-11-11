/** Abstract syntax tree for Requestscript. */

// ---------- Types ----------

export type TypeNode =
  | { kind: 'int32' }
  | { kind: 'int64' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'object' }
  | { kind: 'decimal'; intDigits?: number; fracDigits?: number }
  | { kind: 'list'; element: TypeNode }
  | StructRef;

/**
 * `path.Name@version` in a type: a struct the host declares (see `StructDecl`). The version is always written,
 * so a struct type always means the same fields. The host resolves it with a `StructResolver`.
 */
export interface StructRef {
  kind: 'struct';
  path: string[];
  name: string;
  version: string;
}

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
  /**
   * Declared with `consumes path.Name[@version]` after the name: an event contract, which the host runs with
   * each event of that type. It declares no parameters or return type; the event's fields are its parameters.
   */
  consumes?: EventRef;
  /**
   * Declared with `payable` before `contract`: the contract accepts money attached to a call, and reads it as
   * the built-in `payment`. Set only when true. An event contract can't be payable, since nobody calls it.
   */
  payable?: true;
}

/** A reference to an event type: `path.Name`, optionally `@version`. */
export interface EventRef {
  path: string[];
  name: string;
  /** Omitted when the script doesn't pin one; the host picks the version. */
  version?: string;
}

/**
 * `event path.Name[@version](field: type, ...)`, optionally preceded by `restricted`: declares an event type,
 * the data its events carry. It has no body. `restricted` asks the host to deliver its events only to
 * contracts its owner deployed.
 */
export interface EventDecl {
  kind: 'event';
  path: string[];
  name: string;
  version: string;
  fields: ParameterDecl[];
  restricted: boolean;
}

/**
 * `struct path.Name@version(field: type, ...)`: declares a struct, a shape of object other types can name. It
 * has no body, and must write its version. Values are checked against it structurally: each declared field is
 * converted to its type, a missing one is null, and fields it doesn't declare are kept.
 */
export interface StructDecl {
  kind: 'struct';
  path: string[];
  name: string;
  version: string;
  fields: ParameterDecl[];
}

export type Declaration = RequestDecl | ContractDecl | EventDecl | StructDecl;

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

/**
 * `const name: dotted.path.ResourceName` or `const name: dotted.path.ResourceName@version` — binds a host
 * resource. A contract must name the version of every versioned resource it binds (see `Resource.version`).
 */
export interface ResourceDeclStatement {
  kind: 'resourceDecl';
  name: string;
  resourcePath: string[];
  resourceName: string;
  /** The version written after `@`, if any. */
  version?: string;
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

/**
 * `emit path.Name(field: value, ...)`: publishes an event. The run collects it in `InterpretResult.events`,
 * and the host publishes the events of a run that succeeds.
 */
export interface EmitStatement {
  kind: 'emit';
  event: EventRef;
  args: NamedArgument[];
  line: number;
  tokens: number;
}

/**
 * `fail message`: fails the run on purpose, as a runtime error does. The host saves no state and publishes no
 * events of a run that fails, and moves none of its money.
 */
export interface FailStatement {
  kind: 'fail';
  message: Expression;
  line: number;
  tokens: number;
}

export type Statement =
  | VarDeclStatement
  | FailStatement
  | EmitStatement
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

/**
 * Money attached to a call, written in braces between the function and its arguments:
 * `ref.fn{amount: ..., payees: [...]}(...)`. The interpreter checks the values and hands them to the host.
 */
export interface CallOptions {
  /** Whole micro-USD, 0 or more. 0 attaches nothing. */
  amount: Expression;
  /** The organizations the money may be paid to. Required in a request script. */
  payees?: Expression;
  /** In a contract: whose funding the money comes from. Required there, and not allowed in a request script. */
  from?: Expression;
  /** In a contract: the key of the funding the money comes from, or null for funding never earmarked. */
  key?: Expression;
}

/** A resource function call: `resourceRef.fn(name: value, ...)`, or `resourceRef.fn{options}(name: value, ...)`. */
export interface CallExpr {
  kind: 'call';
  callee: MemberExpr;
  args: NamedArgument[];
  /** Money attached to the call, when written. */
  options?: CallOptions;
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
