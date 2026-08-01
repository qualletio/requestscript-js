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
}

export type Declaration = RequestDecl | ContractDecl;

export interface Script {
  declaration: Declaration;
  body: Statement[];
}

// ---------- Statements ----------

export interface VarDeclStatement {
  kind: 'varDecl';
  constant: boolean;
  name: string;
  type?: TypeNode;
  value: Expression;
  line: number;
}

/** `const name: dotted.path.ResourceName` — binds a host resource. */
export interface ResourceDeclStatement {
  kind: 'resourceDecl';
  name: string;
  resourcePath: string[];
  resourceName: string;
  line: number;
}

export interface AssignStatement {
  kind: 'assign';
  target: IdentifierExpr | MemberExpr | IndexExpr;
  value: Expression;
  line: number;
}

export interface ReturnStatement {
  kind: 'return';
  value?: Expression;
  line: number;
}

export interface IfBranch {
  condition: Expression;
  body: Statement[];
}

export interface IfStatement {
  kind: 'if';
  branches: IfBranch[];
  elseBody?: Statement[];
  line: number;
}

export interface ExpressionStatement {
  kind: 'exprStmt';
  expression: Expression;
  line: number;
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
}

export interface DecimalLiteralExpr {
  kind: 'decimalLiteral';
  raw: string;
  line: number;
}

export interface BooleanLiteralExpr {
  kind: 'booleanLiteral';
  value: boolean;
  line: number;
}

export interface NullLiteralExpr {
  kind: 'nullLiteral';
  line: number;
}

export interface StringLiteralExpr {
  kind: 'stringLiteral';
  value: string;
  line: number;
}

export type TemplatePart = { type: 'text'; value: string } | { type: 'expr'; expression: Expression };

/** A string literal containing `${...}` interpolations. */
export interface TemplateStringExpr {
  kind: 'templateString';
  parts: TemplatePart[];
  line: number;
}

export interface ObjectLiteralExpr {
  kind: 'objectLiteral';
  entries: { key: string; value: Expression }[];
  line: number;
}

export interface ListLiteralExpr {
  kind: 'listLiteral';
  elements: Expression[];
  line: number;
}

export interface IdentifierExpr {
  kind: 'identifier';
  name: string;
  line: number;
}

export interface MemberExpr {
  kind: 'member';
  object: Expression;
  property: string;
  line: number;
}

export interface IndexExpr {
  kind: 'index';
  object: Expression;
  index: Expression;
  line: number;
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
}

export type UnaryOperator = '!' | '-';

export interface UnaryExpr {
  kind: 'unary';
  operator: UnaryOperator;
  operand: Expression;
  line: number;
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
