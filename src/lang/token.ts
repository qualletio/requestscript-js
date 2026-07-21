/** Keywords reserved by the language. */
export const KEYWORDS = [
  'request',
  'contract',
  'var',
  'const',
  'return',
  'if',
  'else',
  'true',
  'false',
  'null',
] as const;

export type Keyword = (typeof KEYWORDS)[number];

export type TokenType =
  | 'identifier'
  | 'int' // integer literal, e.g. 123
  | 'decimal' // decimal literal, e.g. 123.45
  | 'string' // string literal, possibly with interpolation parts
  | Keyword
  | '{'
  | '}'
  | '('
  | ')'
  | '['
  | ']'
  | ':'
  | ','
  | '.'
  | '='
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '!'
  | '+'
  | '-'
  | '*'
  | '/'
  | 'eof';

/** A literal chunk of text inside a string literal. */
export interface StringPartText {
  type: 'text';
  value: string;
}

/** An interpolated `${...}` expression inside a string literal, kept as raw tokens. */
export interface StringPartExpr {
  type: 'expr';
  tokens: Token[];
}

export type StringPart = StringPartText | StringPartExpr;

export interface Token {
  type: TokenType;
  /** Raw text of the token (identifier name, number text, etc.). */
  value: string;
  /** Only present on 'string' tokens: literal text and interpolation parts. */
  parts?: StringPart[];
  line: number;
  column: number;
}
