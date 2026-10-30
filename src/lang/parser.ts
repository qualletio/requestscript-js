import type {
  AssignStatement,
  BinaryExpr,
  BinaryOperator,
  ContractDecl,
  Expression,
  IfBranch,
  IfStatement,
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
  /** What is being parsed, and how many blocks deep: state variables are only allowed at a contract's top level. */
  private declarationKind: 'request' | 'contract' | undefined;
  private depth = 0;
  /** Each node's full token span, children included, so a parent can work out the tokens it owns. */
  private readonly spans = new WeakMap<object, number>();

  constructor(private readonly tokens: Token[]) {}

  // ---------- token ownership ----------

  /**
   * Sets `node.tokens` to the tokens consumed since `start` that its
   * `children` don't own, and records the node's full span for its parent.
   */
  private owned<T extends { tokens: number }>(node: T, start: number, children: readonly object[] = []): T {
    const span = this.pos - start;
    this.spans.set(node, span);
    node.tokens = span - this.spanOf(children);
    return node;
  }

  private spanOf(nodes: readonly object[]): number {
    return nodes.reduce((sum, node) => sum + (this.spans.get(node) ?? 0), 0);
  }

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
      this.declarationKind = 'request';
      const name = this.expect('identifier', 'as the request name').value;
      const body = this.parseBlock();
      return { declaration: { kind: 'request', name }, body };
    }
    if (this.match('contract')) {
      this.declarationKind = 'contract';
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
    const version = this.match('@') ? this.parseContractVersion() : '1';
    const parameters: ParameterDecl[] = this.check('(') ? this.parseParameterList() : [];
    const returnType = this.match(':') ? this.parseType() : undefined;
    return { kind: 'contract', path: segments, name, version, parameters, ...(returnType && { returnType }) };
  }

  /**
   * Parses a dot-separated numeric version such as '2', '1.5', or '1.2.3'.
   * The lexer splits 'x.y.z' into number and '.' tokens, so the version is
   * reassembled from consecutive tokens; adjacency is checked so that
   * whitespace does not silently join into one version.
   */
  private parseContractVersion(): string {
    const numberToken = (): Token => {
      const token = this.peek();
      if (token.type !== 'int' && token.type !== 'decimal') {
        throw this.error(`The contract version after '@' must be dot-separated numbers, e.g. '2' or '1.2.3'`, token);
      }
      return this.advance();
    };
    const adjacent = (previous: Token, next: Token): boolean =>
      next.line === previous.line && next.column === previous.column + previous.value.length;

    let previous = numberToken();
    let version = previous.value;
    while (this.check('.') && adjacent(previous, this.peek())) {
      previous = this.advance(); // '.'
      const next = this.peek();
      if (!adjacent(previous, next)) {
        throw this.error(`The contract version must not contain spaces`, next);
      }
      previous = numberToken();
      version += `.${previous.value}`;
    }
    return version;
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
    this.depth++;
    const statements: Statement[] = [];
    while (!this.check('}')) {
      if (this.check('eof')) throw this.error(`Expected '}' to close a block`);
      statements.push(this.parseStatement());
    }
    this.expect('}', 'to end a block');
    this.depth--;
    return statements;
  }

  /**
   * `state` is not a keyword: it starts a state declaration only when a name or a `(scope)` follows it, so
   * `var state = 1` still declares a variable called `state`.
   */
  private atStateModifier(): boolean {
    const next = this.peek(1).type;
    return this.check('identifier') && this.peek().value === 'state' && (next === 'identifier' || next === '(');
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
    const start = this.pos;
    const keyword = this.advance(); // var or const
    let state: { scope?: Expression } | undefined;
    if (this.atStateModifier()) {
      const modifier = this.advance();
      if (constant) {
        throw this.error(`State variables must be declared with 'var'`, modifier);
      }
      if (this.declarationKind !== 'contract') {
        throw this.error(`State variables can only be declared in a contract`, modifier);
      }
      if (this.depth !== 1) {
        throw this.error(`State variables must be declared at the top level of the contract body`, modifier);
      }
      state = {};
      if (this.match('(')) {
        state.scope = this.parseExpression();
        this.expect(')', 'after the state scope');
      }
    }
    const nameToken = this.expect('identifier', `as the ${constant ? 'const' : 'var'} name`);
    const name = nameToken.value;

    let type: TypeNode | undefined;
    if (this.match(':')) {
      // A non-builtin dotted type name is a resource reference declaration.
      if (this.check('identifier') && !BUILTIN_TYPE_NAMES.has(this.peek().value)) {
        if (state) {
          throw this.error(`A state variable can't hold a resource reference`, keyword);
        }
        return this.parseResourceDecl(constant, name, keyword, start);
      }
      type = this.parseType();
    }

    this.expect('=', `after the ${constant ? 'const' : 'var'} declaration of '${name}'`);
    const value = this.parseExpression();
    const statement: VarDeclStatement = { kind: 'varDecl', constant, name, value, line: keyword.line, tokens: 0 };
    if (type !== undefined) statement.type = type;
    if (state) statement.state = state;
    return this.owned(statement, start, state?.scope ? [value, state.scope] : [value]);
  }

  private parseResourceDecl(constant: boolean, name: string, keyword: Token, start: number): Statement {
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
    return this.owned(
      { kind: 'resourceDecl', name, resourcePath: segments, resourceName, line: keyword.line, tokens: 0 },
      start,
    );
  }

  private parseReturn(): Statement {
    const start = this.pos;
    const keyword = this.advance();
    // A return value must start on the same line as 'return'; otherwise the
    // return is bare and the next token belongs to a (dead) statement.
    const next = this.peek();
    const hasValue = next.type !== '}' && next.type !== 'eof' && next.line === keyword.line;
    if (!hasValue) return this.owned({ kind: 'return', line: keyword.line, tokens: 0 }, start);
    const value = this.parseExpression();
    return this.owned({ kind: 'return', value, line: keyword.line, tokens: 0 }, start, [value]);
  }

  private parseIf(): Statement {
    const start = this.pos;
    const keyword = this.advance();
    const branches: IfBranch[] = [this.parseIfBranch(start)];
    const statement: IfStatement = { kind: 'if', branches, line: keyword.line, tokens: 0 };
    for (;;) {
      const branchStart = this.pos;
      if (!this.match('else')) break;
      if (this.match('if')) {
        branches.push(this.parseIfBranch(branchStart));
      } else {
        const elseBody = this.parseBlock();
        statement.elseBody = elseBody;
        statement.elseTokens = this.pos - branchStart - this.spanOf(elseBody);
        break;
      }
    }
    // The branches and the else own all of the statement's tokens.
    this.spans.set(statement, this.pos - start);
    return statement;
  }

  /** Parses a branch's condition and body; `start` is where its `if` or `else` keyword began. */
  private parseIfBranch(start: number): IfBranch {
    this.expect('(', 'to start the if condition');
    const condition = this.parseExpression();
    this.expect(')', 'to end the if condition');
    const body = this.parseBlock();
    return this.owned({ condition, body, tokens: 0 }, start, [condition, ...body]);
  }

  private parseAssignOrExpressionStatement(): Statement {
    const startPos = this.pos;
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
        tokens: 0,
      };
      return this.owned(statement, startPos, [expression, value]);
    }
    return this.owned({ kind: 'exprStmt', expression, line: start.line, tokens: 0 }, startPos, [expression]);
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
    const start = this.pos;
    let left = next();
    for (;;) {
      const token = this.peek();
      if (!(operators as string[]).includes(token.type)) return left;
      this.advance();
      const right = next();
      const binary: BinaryExpr = { kind: 'binary', operator: token.type as BinaryOperator, left, right, line: token.line, tokens: 0 };
      left = this.owned(binary, start, [left, right]);
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
    const start = this.pos;
    const token = this.peek();
    if (token.type === '!' || token.type === '-') {
      this.advance();
      const operand = this.parseUnary();
      return this.owned({ kind: 'unary', operator: token.type, operand, line: token.line, tokens: 0 }, start, [operand]);
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    const start = this.pos;
    let expression = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (this.match('.')) {
        const property = this.expect('identifier', `after '.'`).value;
        expression = this.owned({ kind: 'member', object: expression, property, line: token.line, tokens: 0 }, start, [expression]);
      } else if (this.match('[')) {
        const index = this.parseExpression();
        this.expect(']', 'to end the index');
        expression = this.owned({ kind: 'index', object: expression, index, line: token.line, tokens: 0 }, start, [expression, index]);
      } else if (this.check('(') && expression.kind === 'member') {
        const args = this.parseCallArguments();
        const children = [expression, ...args.map((arg) => arg.value)];
        expression = this.owned({ kind: 'call', callee: expression as MemberExpr, args, line: token.line, tokens: 0 }, start, children);
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
    const start = this.pos;
    const token = this.peek();
    switch (token.type) {
      case 'int': {
        this.advance();
        return this.owned({ kind: 'intLiteral', value: BigInt(token.value), line: token.line, tokens: 0 }, start);
      }
      case 'decimal': {
        this.advance();
        return this.owned({ kind: 'decimalLiteral', raw: token.value, line: token.line, tokens: 0 }, start);
      }
      case 'true': {
        this.advance();
        return this.owned({ kind: 'booleanLiteral', value: true, line: token.line, tokens: 0 }, start);
      }
      case 'false': {
        this.advance();
        return this.owned({ kind: 'booleanLiteral', value: false, line: token.line, tokens: 0 }, start);
      }
      case 'null': {
        this.advance();
        return this.owned({ kind: 'nullLiteral', line: token.line, tokens: 0 }, start);
      }
      case 'string': {
        this.advance();
        return this.owned(this.stringExpression(token), start);
      }
      case 'identifier': {
        this.advance();
        return this.owned({ kind: 'identifier', name: token.value, line: token.line, tokens: 0 }, start);
      }
      case '(': {
        // The parentheses belong to whichever node encloses the expression.
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

  /**
   * A string is one token, and owns only that token: each interpolated
   * expression is parsed from its own token stream and owns its tokens itself.
   */
  private stringExpression(token: Token): Expression {
    const parts = token.parts ?? [];
    const isPlain = parts.every((part) => part.type === 'text');
    if (isPlain) {
      const value = parts.map((part) => (part.type === 'text' ? part.value : '')).join('');
      return { kind: 'stringLiteral', value, line: token.line, tokens: 0 };
    }
    const templateParts: TemplatePart[] = parts.map((part) => {
      if (part.type === 'text') return { type: 'text', value: part.value };
      const expression = new Parser(part.tokens).parseExpressionToEof();
      return { type: 'expr', expression };
    });
    return { kind: 'templateString', parts: templateParts, line: token.line, tokens: 0 };
  }

  private parseObjectLiteral(): Expression {
    const startPos = this.pos;
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
    return this.owned({ kind: 'objectLiteral', entries, line: start.line, tokens: 0 }, startPos, entries.map((entry) => entry.value));
  }

  private parseListLiteral(): Expression {
    const startPos = this.pos;
    const start = this.expect('[', 'to start the list');
    const elements: Expression[] = [];
    while (!this.check(']')) {
      elements.push(this.parseExpression());
      if (!this.match(',')) break;
    }
    this.expect(']', 'to end the list');
    return this.owned({ kind: 'listLiteral', elements, line: start.line, tokens: 0 }, startPos, elements);
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
