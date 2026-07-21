import type {
  AssignStatement,
  BinaryOperator,
  ContractDecl,
  Expression,
  IfBranch,
  MemberExpr,
  NamedArgument,
  ParameterDecl,
  Script,
  Statement,
  TemplatePart,
  TypeNode,
  VarDeclStatement,
} from './ast.js';
import { ParseError } from './errors.js';
import { tokenize } from './lexer.js';
import type { Token, TokenType } from './token.js';

const BUILTIN_TYPE_NAMES = new Set(['int32', 'int64', 'decimal', 'boolean', 'string', 'object']);

export class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  // ---------- token helpers ----------

  private peek(offset = 0): Token {
    const token = this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    if (!token) throw new ParseError('Unexpected end of input');
    return token;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== 'eof') this.pos += 1;
    return token;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(type: TokenType): Token | undefined {
    if (this.check(type)) return this.advance();
    return undefined;
  }

  private expect(type: TokenType, context: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new ParseError(
        `Expected '${type}' ${context} but found '${token.type === 'eof' ? 'end of script' : token.value || token.type}'`,
        token.line,
        token.column,
      );
    }
    return this.advance();
  }

  private error(message: string, token: Token = this.peek()): ParseError {
    return new ParseError(message, token.line, token.column);
  }

  // ---------- script ----------

  parseScript(): Script {
    const script = this.parseDeclarationAndBody();
    this.expect('eof', 'after the script body');
    return script;
  }

  private parseDeclarationAndBody(): Script {
    if (this.match('request')) {
      const name = this.expect('identifier', 'as the request name').value;
      const body = this.parseBlock();
      return { declaration: { kind: 'request', name }, body };
    }
    if (this.match('contract')) {
      const declaration = this.parseContractDecl();
      const body = this.parseBlock();
      return { declaration, body };
    }
    throw this.error(`A script must start with 'request' or 'contract'`);
  }

  /** Contract path segments may be any word, including keywords (e.g. 'path.to.contract.Name'). */
  private expectPathSegment(context: string): string {
    const token = this.peek();
    if (token.type === 'identifier' || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token.value)) {
      this.advance();
      return token.value;
    }
    throw this.error(`Expected a name ${context} but found '${token.value || token.type}'`, token);
  }

  private parseContractDecl(): ContractDecl {
    const segments = [this.expectPathSegment('as the contract name')];
    while (this.match('.')) {
      segments.push(this.expectPathSegment('in the contract path'));
    }
    const name = segments.pop()!;
    const parameters: ParameterDecl[] = this.check('(') ? this.parseParameterList() : [];
    return { kind: 'contract', path: segments, name, parameters };
  }

  private parseParameterList(): ParameterDecl[] {
    this.expect('(', 'to start the parameter list');
    const parameters: ParameterDecl[] = [];
    const seen = new Set<string>();
    while (!this.check(')')) {
      const nameToken = this.expect('identifier', 'as a parameter name');
      if (seen.has(nameToken.value)) {
        throw this.error(`Duplicate parameter '${nameToken.value}'`, nameToken);
      }
      seen.add(nameToken.value);
      this.expect(':', 'after the parameter name');
      const type = this.parseType();
      parameters.push({ name: nameToken.value, type });
      if (!this.match(',')) break;
    }
    this.expect(')', 'to end the parameter list');
    if (parameters.length === 0) {
      throw this.error('A parameter list must not be empty; omit the parentheses instead');
    }
    return parameters;
  }

  // ---------- types ----------

  parseTypeToEof(): TypeNode {
    const type = this.parseType();
    this.expect('eof', 'after the type');
    return type;
  }

  private parseType(): TypeNode {
    if (this.match('[')) {
      this.expect(']', "after '[' in a list type");
      return { kind: 'list', element: this.parseType() };
    }
    const token = this.expect('identifier', 'as a type name');
    switch (token.value) {
      case 'int32':
      case 'int64':
      case 'boolean':
      case 'string':
      case 'object':
        return { kind: token.value };
      case 'decimal': {
        if (this.match('(')) {
          const intDigits = this.parseTypeDigits('places before the decimal point');
          this.expect(',', 'between the decimal digit counts');
          const fracDigits = this.parseTypeDigits('places after the decimal point');
          this.expect(')', 'to end the decimal type');
          return { kind: 'decimal', intDigits, fracDigits };
        }
        return { kind: 'decimal' };
      }
      default:
        throw this.error(`Unknown type '${token.value}'`, token);
    }
  }

  private parseTypeDigits(what: string): number {
    const token = this.expect('int', `as the number of ${what}`);
    const value = Number(token.value);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw this.error(`Invalid number of ${what}`, token);
    }
    return value;
  }

  // ---------- statements ----------

  private parseBlock(): Statement[] {
    this.expect('{', 'to start a block');
    const statements: Statement[] = [];
    while (!this.check('}')) {
      if (this.check('eof')) throw this.error(`Expected '}' to close a block`);
      statements.push(this.parseStatement());
    }
    this.expect('}', 'to end a block');
    return statements;
  }

  private parseStatement(): Statement {
    const token = this.peek();
    switch (token.type) {
      case 'var':
        return this.parseVarDecl(false);
      case 'const':
        return this.parseVarDecl(true);
      case 'return':
        return this.parseReturn();
      case 'if':
        return this.parseIf();
      default:
        return this.parseAssignOrExpressionStatement();
    }
  }

  private parseVarDecl(constant: boolean): Statement {
    const keyword = this.advance(); // var or const
    const nameToken = this.expect('identifier', `as the ${constant ? 'const' : 'var'} name`);
    const name = nameToken.value;

    let type: TypeNode | undefined;
    if (this.match(':')) {
      // A non-builtin dotted type name is a resource reference declaration.
      if (this.check('identifier') && !BUILTIN_TYPE_NAMES.has(this.peek().value)) {
        return this.parseResourceDecl(constant, name, keyword);
      }
      type = this.parseType();
    }

    this.expect('=', `after the ${constant ? 'const' : 'var'} declaration of '${name}'`);
    const value = this.parseExpression();
    const statement: VarDeclStatement = { kind: 'varDecl', constant, name, value, line: keyword.line };
    if (type !== undefined) statement.type = type;
    return statement;
  }

  private parseResourceDecl(constant: boolean, name: string, keyword: Token): Statement {
    const segments = [this.expect('identifier', 'in the resource reference').value];
    while (this.match('.')) {
      segments.push(this.expect('identifier', 'in the resource reference').value);
    }
    if (this.check('=')) {
      throw this.error(`Unknown type '${segments.join('.')}'`, keyword);
    }
    if (!constant) {
      throw this.error(`Resource references must be declared with 'const'`, keyword);
    }
    const resourceName = segments.pop()!;
    return {
      kind: 'resourceDecl',
      name,
      resourcePath: segments,
      resourceName,
      line: keyword.line,
    };
  }

  private parseReturn(): Statement {
    const keyword = this.advance();
    // A return value must start on the same line as 'return'; otherwise the
    // return is bare and the next token belongs to a (dead) statement.
    const next = this.peek();
    const hasValue = next.type !== '}' && next.type !== 'eof' && next.line === keyword.line;
    if (!hasValue) return { kind: 'return', line: keyword.line };
    return { kind: 'return', value: this.parseExpression(), line: keyword.line };
  }

  private parseIf(): Statement {
    const keyword = this.advance();
    const branches: IfBranch[] = [this.parseIfBranch()];
    let elseBody: Statement[] | undefined;
    while (this.match('else')) {
      if (this.match('if')) {
        branches.push(this.parseIfBranch());
      } else {
        elseBody = this.parseBlock();
        break;
      }
    }
    const statement: Statement = { kind: 'if', branches, line: keyword.line };
    if (elseBody !== undefined) statement.elseBody = elseBody;
    return statement;
  }

  private parseIfBranch(): IfBranch {
    this.expect('(', 'to start the if condition');
    const condition = this.parseExpression();
    this.expect(')', 'to end the if condition');
    const body = this.parseBlock();
    return { condition, body };
  }

  private parseAssignOrExpressionStatement(): Statement {
    const start = this.peek();
    const expression = this.parseExpression();
    if (this.match('=')) {
      if (expression.kind !== 'identifier' && expression.kind !== 'member' && expression.kind !== 'index') {
        throw this.error('Invalid assignment target', start);
      }
      const value = this.parseExpression();
      const statement: AssignStatement = {
        kind: 'assign',
        target: expression,
        value,
        line: start.line,
      };
      return statement;
    }
    return { kind: 'exprStmt', expression, line: start.line };
  }

  // ---------- expressions ----------

  parseExpression(): Expression {
    return this.parseOr();
  }

  /** Parses a full expression and requires the whole token stream to be consumed. */
  parseExpressionToEof(): Expression {
    const expression = this.parseExpression();
    this.expect('eof', 'after the expression');
    return expression;
  }

  private parseBinaryLevel(operators: BinaryOperator[], next: () => Expression): Expression {
    let left = next();
    for (;;) {
      const token = this.peek();
      if (!(operators as string[]).includes(token.type)) return left;
      this.advance();
      const right = next();
      left = { kind: 'binary', operator: token.type as BinaryOperator, left, right, line: token.line };
    }
  }

  private parseOr(): Expression {
    return this.parseBinaryLevel(['||'], () => this.parseAnd());
  }

  private parseAnd(): Expression {
    return this.parseBinaryLevel(['&&'], () => this.parseEquality());
  }

  private parseEquality(): Expression {
    return this.parseBinaryLevel(['==', '!='], () => this.parseComparison());
  }

  private parseComparison(): Expression {
    return this.parseBinaryLevel(['<', '<=', '>', '>='], () => this.parseAdditive());
  }

  private parseAdditive(): Expression {
    return this.parseBinaryLevel(['+', '-'], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Expression {
    return this.parseBinaryLevel(['*', '/'], () => this.parseUnary());
  }

  private parseUnary(): Expression {
    const token = this.peek();
    if (token.type === '!' || token.type === '-') {
      this.advance();
      return { kind: 'unary', operator: token.type, operand: this.parseUnary(), line: token.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    let expression = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (this.match('.')) {
        const property = this.expect('identifier', `after '.'`).value;
        expression = { kind: 'member', object: expression, property, line: token.line };
      } else if (this.match('[')) {
        const index = this.parseExpression();
        this.expect(']', 'to end the index');
        expression = { kind: 'index', object: expression, index, line: token.line };
      } else if (this.check('(') && expression.kind === 'member') {
        const args = this.parseCallArguments();
        expression = { kind: 'call', callee: expression as MemberExpr, args, line: token.line };
      } else {
        return expression;
      }
    }
  }

  private parseCallArguments(): NamedArgument[] {
    this.expect('(', 'to start the call arguments');
    const args: NamedArgument[] = [];
    const seen = new Set<string>();
    while (!this.check(')')) {
      const nameToken = this.expect('identifier', 'as an argument name');
      if (seen.has(nameToken.value)) {
        throw this.error(`Duplicate argument '${nameToken.value}'`, nameToken);
      }
      seen.add(nameToken.value);
      this.expect(':', 'after the argument name');
      args.push({ name: nameToken.value, value: this.parseExpression() });
      if (!this.match(',')) break;
    }
    this.expect(')', 'to end the call arguments');
    return args;
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    switch (token.type) {
      case 'int': {
        this.advance();
        return { kind: 'intLiteral', value: BigInt(token.value), line: token.line };
      }
      case 'decimal': {
        this.advance();
        return { kind: 'decimalLiteral', raw: token.value, line: token.line };
      }
      case 'true': {
        this.advance();
        return { kind: 'booleanLiteral', value: true, line: token.line };
      }
      case 'false': {
        this.advance();
        return { kind: 'booleanLiteral', value: false, line: token.line };
      }
      case 'null': {
        this.advance();
        return { kind: 'nullLiteral', line: token.line };
      }
      case 'string': {
        this.advance();
        return this.stringExpression(token);
      }
      case 'identifier': {
        this.advance();
        return { kind: 'identifier', name: token.value, line: token.line };
      }
      case '(': {
        this.advance();
        const expression = this.parseExpression();
        this.expect(')', 'to close the parenthesized expression');
        return expression;
      }
      case '{':
        return this.parseObjectLiteral();
      case '[':
        return this.parseListLiteral();
      default:
        throw this.error(
          `Unexpected ${token.type === 'eof' ? 'end of script' : `'${token.value || token.type}'`}`,
          token,
        );
    }
  }

  private stringExpression(token: Token): Expression {
    const parts = token.parts ?? [];
    const isPlain = parts.every((part) => part.type === 'text');
    if (isPlain) {
      const value = parts.map((part) => (part.type === 'text' ? part.value : '')).join('');
      return { kind: 'stringLiteral', value, line: token.line };
    }
    const templateParts: TemplatePart[] = parts.map((part) => {
      if (part.type === 'text') return { type: 'text', value: part.value };
      const expression = new Parser(part.tokens).parseExpressionToEof();
      return { type: 'expr', expression };
    });
    return { kind: 'templateString', parts: templateParts, line: token.line };
  }

  private parseObjectLiteral(): Expression {
    const start = this.expect('{', 'to start the object');
    const entries: { key: string; value: Expression }[] = [];
    const seen = new Set<string>();
    while (!this.check('}')) {
      const keyToken = this.expect('identifier', 'as an object key');
      if (seen.has(keyToken.value)) {
        throw this.error(`Duplicate object key '${keyToken.value}'`, keyToken);
      }
      seen.add(keyToken.value);
      this.expect(':', 'after the object key');
      entries.push({ key: keyToken.value, value: this.parseExpression() });
      if (!this.match(',')) break;
    }
    this.expect('}', 'to end the object');
    return { kind: 'objectLiteral', entries, line: start.line };
  }

  private parseListLiteral(): Expression {
    const start = this.expect('[', 'to start the list');
    const elements: Expression[] = [];
    while (!this.check(']')) {
      elements.push(this.parseExpression());
      if (!this.match(',')) break;
    }
    this.expect(']', 'to end the list');
    return { kind: 'listLiteral', elements, line: start.line };
  }
}

/** Parses a complete Requestscript script from source text. */
export function parseScript(source: string): Script {
  return new Parser(tokenize(source)).parseScript();
}

/** Parses a type string such as 'int32' or '[]string' (used for resource function signatures). */
export function parseTypeString(type: string): TypeNode {
  try {
    return new Parser(tokenize(type)).parseTypeToEof();
  } catch {
    throw new ParseError(`Invalid type '${type}'`);
  }
}
