import type {
  CallOptions,
  FailStatement,
  AssignStatement,
  BinaryExpr,
  BinaryOperator,
  ContractDecl,
  EmitStatement,
  EventDecl,
  EventRef,
  Expression,
  FnCallExpr,
  FunctionDecl,
  IfBranch,
  IfStatement,
  LambdaExpr,
  MemberExpr,
  NamedArgument,
  ParameterDecl,
  RenderingDecl,
  Script,
  Statement,
  StructDecl,
  StructRef,
  TemplatePart,
  TypeNode,
  VarDeclStatement,
  ViewArgument,
  ViewExpr,
} from './ast.js';
import { ParseError } from './errors.js';
import { EVENT_HANDLER, RENDER_FUNCTION } from './functions.js';
import { tokenize } from './lexer.js';
import { typeToString } from './types.js';
import type { Token, TokenType } from './token.js';
import { COMPONENTS, isComponent, MODIFIERS, type ComponentSpec, type ViewArgumentType } from './views.js';
import { childExpressions, statementBlocks, statementExpressions, walkExpressions, walkNestedStatements as walkStatementsIn } from './walk.js';

const BUILTIN_TYPE_NAMES = new Set(['int32', 'int64', 'decimal', 'boolean', 'string', 'object']);

export class Parser {
  private pos = 0;
  /** What is being parsed, and how many blocks deep: state variables are only allowed at a contract's top level. */
  private declarationKind: 'request' | 'contract' | 'rendering' | undefined;
  /** Set while parsing an event contract's body. */
  private consumer = false;
  private depth = 0;
  /** The function whose body is being parsed, if any: a function without a return type can't return a value. */
  private currentFunction: FunctionDecl | undefined;
  /** Every call to one of the contract's functions, with the function it is in, resolved once all are parsed. */
  private fnCalls: { call: FnCallExpr; caller: FunctionDecl | undefined; inLambda: boolean }[] = [];
  /** A rendering's lambdas, in source order, shared with the parsers of string interpolations. */
  private lambdas: LambdaExpr[] = [];
  /** How many lambda bodies deep the parser is. */
  private lambdaDepth = 0;
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
      if (this.fnCalls.length > 0) {
        const { call } = this.fnCalls[0]!;
        throw new ParseError(`A request script has no functions, so '${call.name}(...)' can't be called`, call.line);
      }
      return { declaration: { kind: 'request', name }, body, functions: [] };
    }
    if (this.peek().type === 'identifier' && this.peek().value === 'payable' && this.peek(1).type === 'contract') {
      throw this.error(`'payable' marks a contract's functions now, not the contract: write 'pub payable fn name(...)' inside it`);
    }
    if (this.match('contract')) {
      this.declarationKind = 'contract';
      const declaration = this.parseContractDecl();
      this.consumer = declaration.consumes !== undefined;
      const { body, functions } = this.parseContractBody(declaration);
      return { declaration, body, functions };
    }
    if (this.atRenderingDecl()) {
      this.advance(); // rendering
      this.declarationKind = 'rendering';
      const declaration = this.parseRenderingDecl();
      const { body, functions } = this.parseContractBody(declaration);
      return { declaration, body, functions, lambdas: this.lambdas };
    }
    if (this.atEventDecl()) {
      return { declaration: this.parseEventDecl(), body: [], functions: [] };
    }
    if (this.atStructDecl()) {
      return { declaration: this.parseStructDecl(), body: [], functions: [] };
    }
    throw this.error(`A script must start with 'request', 'contract', 'rendering', 'event' or 'struct'`);
  }

  /** `rendering` is not a keyword: it starts a rendering only at the start of a script, before a name. */
  private atRenderingDecl(): boolean {
    return this.peek().type === 'identifier' && this.peek().value === 'rendering' && isPathWord(this.peek(1)) && this.peek(1).type !== 'eof';
  }

  private parseRenderingDecl(): RenderingDecl {
    const { path, name } = this.parsePath('rendering');
    const version = this.match('@') ? this.parseContractVersion('rendering') : '1';
    if (this.check('(')) {
      throw this.error(`A rendering takes no parameters: its UI is built by 'pub fn ${RENDER_FUNCTION}()'`);
    }
    if (this.check(':')) {
      throw this.error('A rendering has no return type');
    }
    if (this.check('identifier') && this.peek().value === 'consumes') {
      throw this.error('A rendering can\'t consume events');
    }
    return { kind: 'rendering', path, name, version };
  }

  /** `protected` is not a keyword: it marks a variable only right before `var`. */
  private atProtected(): boolean {
    return this.peek().type === 'identifier' && this.peek().value === 'protected' && this.peek(1).type === 'var';
  }

  /** A rendering can't use a component's name for anything else, since that name always builds the component. */
  private checkName(name: string, what: string, token?: Token): void {
    if (this.declarationKind === 'rendering' && isComponent(name)) {
      throw this.error(`'${name}' is a component, so it can't be the name of a ${what}`, token);
    }
  }

  /** `struct` is not a keyword: it starts a struct declaration only at the start of a script, before a name. */
  private atStructDecl(): boolean {
    return this.peek().type === 'identifier' && this.peek().value === 'struct' && this.peek(1).type === 'identifier';
  }

  private parseStructDecl(): StructDecl {
    this.advance(); // struct
    const { path, name } = this.parsePath('struct');
    const label = [...path, name].join('.');
    if (!this.match('@')) {
      throw this.error(`A struct must declare its version, e.g. 'struct ${label}@1(...)'`);
    }
    const version = this.parseContractVersion('struct');
    if (this.check('{')) {
      throw this.error('A struct declares only its fields, so it has no body');
    }
    if (!this.check('(')) {
      throw this.error(`A struct must declare its fields, e.g. 'struct ${label}@${version}(name: string)'`);
    }
    const fields = this.parseParameterList();
    if (this.check('{')) {
      throw this.error('A struct declares only its fields, so it has no body');
    }
    if (this.check(':')) {
      throw this.error('A struct has fields, not a return type');
    }
    const self = `${label}@${version}`;
    for (const field of fields) {
      if (refersTo(field.type, self)) {
        throw this.error(`Struct '${self}' can't refer to itself, as field '${field.name}' does`);
      }
    }
    return { kind: 'struct', path, name, version, fields };
  }

  /** `event` and `restricted` are not keywords: they start an event declaration only at the start of a script, before a name. */
  private atEventDecl(): boolean {
    const word = (offset: number, value: string) => this.peek(offset).type === 'identifier' && this.peek(offset).value === value;
    return (word(0, 'event') && this.peek(1).type === 'identifier')
      || (word(0, 'restricted') && word(1, 'event') && this.peek(2).type === 'identifier');
  }

  private parseEventDecl(): EventDecl {
    const restricted = this.peek().value === 'restricted';
    if (restricted) this.advance();
    this.advance(); // event
    const { path, name } = this.parsePath('event');
    const version = this.match('@') ? this.parseContractVersion('event') : '1';
    const fields: ParameterDecl[] = this.check('(') ? this.parseParameterList() : [];
    if (this.check('{')) {
      throw this.error('An event declares only its fields, so it has no body');
    }
    if (this.check(':')) {
      throw this.error('An event has fields, not a return type');
    }
    return { kind: 'event', path, name, version, fields, restricted };
  }

  /** A dotted name such as `com.example.Name`: its path segments and its last segment. */
  private parsePath(what: string): { path: string[]; name: string } {
    const segments = [this.expectPathSegment(`as the ${what} name`)];
    while (this.match('.')) {
      segments.push(this.expectPathSegment(`in the ${what} path`));
    }
    const name = segments.pop()!;
    return { path: segments, name };
  }

  /** `path.Name` or `path.Name@version`, naming an event type. */
  private parseEventRef(): EventRef {
    const { path, name } = this.parsePath('event');
    if (!this.match('@')) return { path, name };
    return { path, name, version: this.parseContractVersion('event') };
  }

  /** Contract path segments may be any word, including keywords (e.g. 'path.to.contract.Name'). */
  private expectPathSegment(context: string): string {
    const token = this.peek();
    if (isPathWord(token)) {
      this.advance();
      return token.value;
    }
    throw this.error(`Expected a name ${context} but found '${token.value || token.type}'`, token);
  }

  private parseContractDecl(): ContractDecl {
    const { path: segments, name } = this.parsePath('contract');
    const version = this.match('@') ? this.parseContractVersion() : '1';
    if (this.check('identifier') && this.peek().value === 'consumes') {
      this.advance();
      const consumes = this.parseEventRef();
      if (this.check('(') || this.check(':')) {
        throw this.error(`An event contract's handler takes the event's fields: declare 'fn ${EVENT_HANDLER}(field: type, ...)' inside it`);
      }
      return { kind: 'contract', path: segments, name, version, consumes };
    }
    if (this.check('(')) {
      throw this.error(`A contract's parameters belong to its functions now: declare 'pub fn name(parameter: type, ...)' inside it`);
    }
    if (this.check(':')) {
      throw this.error(`A contract's return type belongs to its functions now: declare 'pub fn name(): type' inside it`);
    }
    return { kind: 'contract', path: segments, name, version };
  }

  /**
   * `{ ... }` after a contract's declaration: its `var state` variables, `const` resource bindings and
   * functions, in any order. Nothing else may appear outside a function.
   */
  private parseContractBody(declaration: ContractDecl | RenderingDecl): { body: Statement[]; functions: FunctionDecl[] } {
    const rendering = declaration.kind === 'rendering';
    const what = rendering ? 'rendering' : 'contract';
    this.expect('{', `to start the ${what} body`);
    this.depth++;
    const body: Statement[] = [];
    const functions: FunctionDecl[] = [];
    while (!this.check('}')) {
      const token = this.peek();
      if (token.type === 'eof') throw this.error(`Expected '}' to close the ${what} body`);
      if (this.atFunction()) {
        const fn = this.parseFunction();
        if (functions.some((other) => other.name === fn.name)) {
          throw new ParseError(`Duplicate function '${fn.name}'`, fn.line);
        }
        functions.push(fn);
        continue;
      }
      if (!rendering && this.atProtected()) {
        throw this.error('Protected variables can only be declared in a rendering');
      }
      if (rendering && this.atProtected()) {
        this.advance(); // protected
        body.push(this.parseVarDecl(false, true));
        continue;
      }
      if (token.type === 'var' || token.type === 'const') {
        const statement = this.parseVarDecl(token.type === 'const');
        if (statement.kind === 'resourceDecl' || (statement.kind === 'varDecl' && statement.state)) {
          body.push(statement);
          continue;
        }
        if (rendering && statement.kind === 'varDecl' && !statement.constant) {
          throw new ParseError(
            `A rendering's top-level variables are 'var state', shared by every viewer, or 'protected var', kept for each viewer's session: write one of them for '${statement.name}'`,
            token.line,
            token.column,
          );
        }
      }
      throw new ParseError(
        rendering
          ? `Outside its functions a rendering declares only state variables ('var state'), protected variables ('protected var'), resource bindings ('const r: path.Name@version') and functions ('fn')`
          : `Outside its functions a contract declares only state variables ('var state'), resource bindings ('const r: path.Name@version') and functions ('fn')`,
        token.line,
        token.column,
      );
    }
    this.expect('}', `to end the ${what} body`);
    this.depth--;
    this.checkFunctions(declaration, body, functions);
    if (rendering) this.checkRender(body, functions);
    return { body, functions };
  }

  /** `fn`, `pub fn`, `pub payable fn`, or `payable fn`, which is refused when parsed. */
  private atFunction(): boolean {
    const payable = (offset: number) => this.peek(offset).type === 'identifier' && this.peek(offset).value === 'payable';
    return this.check('fn') || this.check('pub') || (payable(0) && (this.peek(1).type === 'fn' || this.peek(1).type === 'pub'));
  }

  private parseFunction(): FunctionDecl {
    const first = this.peek();
    if (first.type === 'identifier') {
      throw this.error(`Only a pub function can be payable, and 'pub' comes first: 'pub payable fn'`);
    }
    const pub = this.match('pub') !== undefined;
    let payable = false;
    if (pub && this.check('identifier') && this.peek().value === 'payable') {
      this.advance();
      payable = true;
    }
    this.expect('fn', pub ? `after '${payable ? 'pub payable' : 'pub'}'` : 'to declare a function');
    const nameToken = this.expect('identifier', 'as the function name');
    const name = nameToken.value;
    this.checkName(name, 'function', nameToken);
    const parameters = this.check('(')
      ? this.parseParameterList(true)
      : (() => { throw this.error(`Function '${name}' needs a parameter list, e.g. '${name}()'`); })();
    const returnType = this.match(':') ? this.parseType() : undefined;
    const fn: FunctionDecl = { name, pub, payable, parameters, body: [], line: first.line };
    if (returnType) fn.returnType = returnType;
    this.currentFunction = fn;
    fn.body = this.parseBlock();
    this.currentFunction = undefined;
    return fn;
  }

  /**
   * The rules that need the whole contract: its entrypoints, the names its functions' parameters may take,
   * and every call to its functions, which must name one, pass its parameters, and never lead back to itself.
   */
  private checkFunctions(declaration: ContractDecl | RenderingDecl, body: Statement[], functions: FunctionDecl[]): void {
    const label = [...declaration.path, declaration.name].join('.');
    const handler = functions.find((fn) => fn.name === EVENT_HANDLER);
    if (declaration.kind === 'rendering') {
      const render = functions.find((fn) => fn.name === RENDER_FUNCTION);
      if (!render || !render.pub) {
        throw this.error(`Rendering '${label}' needs its entrypoint: 'pub fn ${RENDER_FUNCTION}() { ... }'`);
      }
      if (render.payable) {
        throw new ParseError(`'${RENDER_FUNCTION}' builds the UI, so it isn't payable`, render.line);
      }
      if (render.parameters.length > 0) {
        throw new ParseError(`'${RENDER_FUNCTION}' takes no parameters: read 'queryParams' and the other built-ins instead`, render.line);
      }
      if (render.returnType) {
        throw new ParseError(`'${RENDER_FUNCTION}' has no return type: the components it writes are the UI`, render.line);
      }
      const other = functions.find((fn) => fn.pub && fn.name !== RENDER_FUNCTION);
      if (other) {
        throw new ParseError(`A rendering's only entrypoint is '${RENDER_FUNCTION}', so function '${other.name}' can't be pub`, other.line);
      }
    } else if (declaration.consumes) {
      if (!handler) {
        throw this.error(`Event contract '${label}' needs a handler: 'fn ${EVENT_HANDLER}(field: type, ...) { ... }'`);
      }
      if (handler.pub) {
        throw new ParseError(`The handler '${EVENT_HANDLER}' runs with each event, so it isn't pub`, handler.line);
      }
      if (handler.returnType) {
        throw new ParseError(`The handler '${EVENT_HANDLER}' has no return type: an event contract returns nothing`, handler.line);
      }
      const pub = functions.find((fn) => fn.pub);
      if (pub) {
        throw new ParseError(`An event contract is only run by its events, so function '${pub.name}' can't be pub`, pub.line);
      }
    } else {
      if (handler) {
        throw new ParseError(`'${EVENT_HANDLER}' is the handler of event contracts; name this function something else`, handler.line);
      }
      if (!functions.some((fn) => fn.pub)) {
        throw this.error(`Contract '${label}' needs at least one entrypoint: 'pub fn name(...) { ... }'`);
      }
    }

    // Parameters are declared in a scope beneath the contract's top level, so they can't reuse its names.
    const topLevel = new Set(body.map((statement) => (statement as { name: string }).name));
    for (const fn of functions) {
      for (const parameter of fn.parameters) {
        if (topLevel.has(parameter.name)) {
          throw new ParseError(`Parameter '${parameter.name}' of function '${fn.name}' has the name of a contract-level declaration`, fn.line);
        }
      }
    }

    // A state variable is the contract's, by name, wherever it is declared, so every declaration of it agrees.
    const stateDeclarations = new Map<string, { statement: VarDeclStatement; fn: FunctionDecl | undefined }>();
    const declarations: { statement: Statement; fn: FunctionDecl | undefined }[] = [
      ...body.map((statement) => ({ statement, fn: undefined })),
      ...functions.flatMap((fn) => fn.body.map((statement) => ({ statement, fn }))),
    ];
    for (const { statement, fn } of declarations) {
      if (statement.kind !== 'varDecl' || !statement.state) continue;
      const first = stateDeclarations.get(statement.name);
      if (!first) {
        stateDeclarations.set(statement.name, { statement, fn });
        continue;
      }
      if (!first.fn || !fn) {
        throw new ParseError(`State variable '${statement.name}' is declared at the contract's top level, so its functions can't declare it again`, statement.line);
      }
      const typeOf = (declaration: VarDeclStatement) => (declaration.type ? typeToString(declaration.type) : undefined);
      if (typeOf(first.statement) !== typeOf(statement) || Boolean(first.statement.state!.scope) !== Boolean(statement.state.scope)) {
        throw new ParseError(
          `State variable '${statement.name}' is declared in functions '${first.fn.name}' and '${fn.name}' with a different type or scoping: every declaration of it must agree`,
          statement.line,
        );
      }
    }

    const byName = new Map(functions.map((fn) => [fn.name, fn]));
    const callees = new Map<string, string[]>(functions.map((fn) => [fn.name, []]));
    for (const { call, caller } of this.fnCalls) {
      const fn = byName.get(call.name);
      if (!fn) {
        throw new ParseError(`Unknown function '${call.name}'`, call.line);
      }
      if (declaration.kind === 'contract' && declaration.consumes && fn.name === EVENT_HANDLER) {
        throw new ParseError(`The handler '${EVENT_HANDLER}' runs with each event; it can't be called`, call.line);
      }
      if (declaration.kind === 'rendering' && fn.name === RENDER_FUNCTION) {
        throw new ParseError(`'${RENDER_FUNCTION}' is run by the host; it can't be called`, call.line);
      }
      const declared = new Set(fn.parameters.map((parameter) => parameter.name));
      for (const arg of call.args) {
        if (!declared.has(arg.name)) {
          throw new ParseError(`Function '${fn.name}' has no parameter '${arg.name}'`, call.line);
        }
      }
      for (const parameter of fn.parameters) {
        if (!call.args.some((arg) => arg.name === parameter.name)) {
          throw new ParseError(`Missing argument '${parameter.name}' for function '${fn.name}'`, call.line);
        }
      }
      if (caller) callees.get(caller.name)!.push(fn.name);
    }

    // No function may lead back to itself: without loops or recursion, a run's tokens stay bounded.
    const done = new Set<string>();
    const visit = (name: string, chain: string[]): void => {
      if (chain.includes(name)) {
        const cycle = [...chain.slice(chain.indexOf(name)), name].join(' -> ');
        throw new ParseError(`Function '${name}' calls itself, which a ${declaration.kind} can't do: ${cycle}`, byName.get(name)!.line);
      }
      if (done.has(name)) return;
      for (const callee of callees.get(name)!) visit(callee, [...chain, name]);
      done.add(name);
    };
    for (const fn of functions) visit(fn.name, []);
  }

  /**
   * `render` and every function it calls build the UI and nothing else: they read state, protected variables
   * and built-ins, but call no resources and assign no state or protected variables. Only actions, the bodies
   * of lambdas, may. So a render changes nothing, and the host can run it whenever it needs the UI.
   */
  private checkRender(body: Statement[], functions: FunctionDecl[]): void {
    const kept = new Set<string>();
    const declared = (statements: Statement[]): void => {
      for (const statement of statements) {
        if (statement.kind === 'varDecl' && (statement.state || statement.protected)) kept.add(statement.name);
      }
    };
    declared(body);
    for (const fn of functions) declared(fn.body);

    const byName = new Map(functions.map((fn) => [fn.name, fn]));
    const reachable: FunctionDecl[] = [];
    const visit = (fn: FunctionDecl): void => {
      if (reachable.includes(fn)) return;
      reachable.push(fn);
      for (const { call, caller, inLambda } of this.fnCalls) {
        if (caller === fn && !inLambda) visit(byName.get(call.name)!);
      }
    };
    visit(byName.get(RENDER_FUNCTION)!);

    const where = (fn: FunctionDecl) => (fn.name === RENDER_FUNCTION ? `'${RENDER_FUNCTION}'` : `function '${fn.name}', which '${RENDER_FUNCTION}' calls,`);
    for (const fn of reachable) {
      const statement = (node: Statement): void => {
        if (node.kind === 'assign') {
          const root = rootName(node.target);
          if (root !== undefined && kept.has(root)) {
            throw new ParseError(`${capitalize(where(fn))} can't change '${root}': only actions change state and protected variables`, node.line);
          }
        }
        for (const child of statementExpressions(node)) expression(child);
        for (const nested of statementBlocks(node)) nested.forEach(statement);
      };
      const expression = (node: Expression): void => {
        if (node.kind === 'call' && !isModifierCall(node)) {
          throw new ParseError(`${capitalize(where(fn))} can't call resources: call them from an action`, node.line);
        }
        for (const child of childExpressions(node)) expression(child);
        if (node.kind === 'view' && node.children) node.children.forEach(statement);
      };
      fn.body.forEach(statement);
    }
  }

  /**
   * Parses a dot-separated numeric version such as '2', '1.5', or '1.2.3'.
   * The lexer splits 'x.y.z' into number and '.' tokens, so the version is
   * reassembled from consecutive tokens; adjacency is checked so that
   * whitespace does not silently join into one version.
   */
  private parseContractVersion(what = 'contract'): string {
    const numberToken = (): Token => {
      const token = this.peek();
      if (token.type !== 'int' && token.type !== 'decimal') {
        throw this.error(`The ${what} version after '@' must be dot-separated numbers, e.g. '2' or '1.2.3'`, token);
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
        throw this.error(`The ${what} version must not contain spaces`, next);
      }
      previous = numberToken();
      version += `.${previous.value}`;
    }
    return version;
  }

  private parseParameterList(allowEmpty = false): ParameterDecl[] {
    this.expect('(', 'to start the parameter list');
    const parameters: ParameterDecl[] = [];
    const seen = new Set<string>();
    while (!this.check(')')) {
      const nameToken = this.expect('identifier', 'as a parameter name');
      this.checkName(nameToken.value, 'parameter', nameToken);
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
    if (parameters.length === 0 && !allowEmpty) {
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
        return this.parseStructType(token);
    }
  }

  /** `path.Name@version` after its first segment: a struct type, which must name its version. */
  private parseStructType(first: Token): StructRef {
    const segments = [first.value];
    while (this.match('.')) {
      segments.push(this.expectPathSegment('in the struct type'));
    }
    if (!this.match('@')) {
      if (segments.length === 1) throw this.error(`Unknown type '${first.value}'`, first);
      throw this.error(`Struct type '${segments.join('.')}' must name its version, e.g. '${segments.join('.')}@1'`, first);
    }
    const version = this.parseContractVersion('struct');
    const name = segments.pop()!;
    return { kind: 'struct', path: segments, name, version };
  }

  /**
   * Whether the dotted name at the current token is followed by `@`, making it a struct type. Without one, a
   * dotted name in a declaration's type is a resource reference.
   */
  private atStructType(): boolean {
    let offset = 0;
    while (this.peek(offset + 1).type === '.' && isPathWord(this.peek(offset + 2))) offset += 2;
    return this.peek(offset + 1).type === '@';
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
        // `emit` is not a keyword: it starts an emit statement only before a name, which no expression can.
        if (token.type === 'identifier' && token.value === 'emit' && this.peek(1).type === 'identifier') {
          if (this.declarationKind === 'rendering') throw this.error('A rendering can\'t emit events');
          return this.parseEmit();
        }
        if (this.atProtected()) {
          throw this.error(this.declarationKind === 'rendering'
            ? `Protected variables are declared at the rendering's top level`
            : `Protected variables can only be declared in a rendering`);
        }
        if (this.atFail()) {
          return this.parseFail();
        }
        return this.parseAssignOrExpressionStatement();
    }
  }

  private parseVarDecl(constant: boolean, protectedVar = false): Statement {
    const start = protectedVar ? this.pos - 1 : this.pos;
    const keyword = this.advance(); // var or const
    let state: { scope?: Expression } | undefined;
    if (this.atStateModifier()) {
      const modifier = this.advance();
      if (constant) {
        throw this.error(`State variables must be declared with 'var'`, modifier);
      }
      if (protectedVar) {
        throw this.error(`A variable is either 'var state' or 'protected var', not both`, modifier);
      }
      if (this.declarationKind !== 'contract' && this.declarationKind !== 'rendering') {
        throw this.error(`State variables can only be declared in a contract or a rendering`, modifier);
      }
      // The contract's top level, or the top of a function's body, where its scope can name the parameters.
      if (this.depth !== 1 && !(this.currentFunction && this.depth === 2)) {
        throw this.error(`State variables must be declared at the contract's top level or at the top level of a function's body`, modifier);
      }
      state = {};
      if (this.match('(')) {
        state.scope = this.parseExpression();
        this.expect(')', 'after the state scope');
      }
    }
    const nameToken = this.expect('identifier', `as the ${constant ? 'const' : 'var'} name`);
    const name = nameToken.value;
    this.checkName(name, constant ? 'const' : 'var', nameToken);

    let type: TypeNode | undefined;
    if (this.match(':')) {
      // A non-builtin dotted type name is a resource reference declaration, unless it names a struct version.
      if (this.check('identifier') && !BUILTIN_TYPE_NAMES.has(this.peek().value) && !this.atStructType()) {
        if (state || protectedVar) {
          throw this.error(`A ${state ? 'state' : 'protected'} variable can't hold a resource reference`, keyword);
        }
        return this.parseResourceDecl(constant, name, keyword, start);
      }
      type = this.parseType();
      // `const r: path.Name@version` with no value binds a version of a resource, not a struct-typed constant.
      if (type.kind === 'struct' && type.path.length > 0 && constant && !this.check('=')) {
        return this.owned(
          { kind: 'resourceDecl', name, resourcePath: type.path, resourceName: type.name, version: type.version, line: keyword.line, tokens: 0 },
          start,
        );
      }
    }

    this.expect('=', `after the ${constant ? 'const' : 'var'} declaration of '${name}'`);
    const value = this.parseExpression();
    const statement: VarDeclStatement = { kind: 'varDecl', constant, name, value, line: keyword.line, tokens: 0 };
    if (type !== undefined) statement.type = type;
    if (state) statement.state = state;
    if (protectedVar) statement.protected = true;
    return this.owned(statement, start, state?.scope ? [value, state.scope] : [value]);
  }

  private parseResourceDecl(constant: boolean, name: string, keyword: Token, start: number): Statement {
    const segments = [this.expect('identifier', 'in the resource reference').value];
    while (this.match('.')) {
      segments.push(this.expect('identifier', 'in the resource reference').value);
    }
    if (this.check('=')) {
      const type = segments.join('.');
      throw this.error(
        segments.length > 1
          ? `Unknown type '${type}': a struct type must name its version, e.g. '${type}@1'`
          : `Unknown type '${type}'`,
        keyword,
      );
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

  private parseEmit(): Statement {
    const start = this.pos;
    const keyword = this.advance(); // emit
    const event = this.parseEventRef();
    const args = this.parseCallArguments();
    const statement: EmitStatement = { kind: 'emit', event, args, line: keyword.line, tokens: 0 };
    return this.owned(statement, start, args.map((arg) => arg.value));
  }

  /**
   * `fail` is not a keyword: it starts a fail statement only when its message follows on the same line, starting
   * with a string, a name, a number or a parenthesis, which no expression starting with `fail` can.
   */
  private atFail(): boolean {
    const token = this.peek();
    const next = this.peek(1);
    return token.type === 'identifier' && token.value === 'fail' && next.line === token.line
      && (next.type === 'string' || next.type === 'identifier' || next.type === 'int' || next.type === '(');
  }

  private parseFail(): Statement {
    const start = this.pos;
    const keyword = this.advance(); // fail
    const message = this.parseExpression();
    const statement: FailStatement = { kind: 'fail', message, line: keyword.line, tokens: 0 };
    return this.owned(statement, start, [message]);
  }

  private parseReturn(): Statement {
    const start = this.pos;
    const keyword = this.advance();
    // A return value must start on the same line as 'return'; otherwise the
    // return is bare and the next token belongs to a (dead) statement.
    const next = this.peek();
    const hasValue = next.type !== '}' && next.type !== 'eof' && next.line === keyword.line;
    if (!hasValue) return this.owned({ kind: 'return', line: keyword.line, tokens: 0 }, start);
    if (this.lambdaDepth > 0) {
      throw this.error('An action returns nothing, so it can\'t return a value', keyword);
    }
    const fn = this.currentFunction;
    if (fn && !fn.returnType) {
      throw this.error(
        this.consumer && fn.name === EVENT_HANDLER
          ? 'An event contract cannot return a value'
          : `Function '${fn.name}' declares no return type, so it can't return a value`,
        keyword,
      );
    }
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
    const operator = this.match('=') ?? this.match('+=') ?? this.match('-=');
    if (operator) {
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
      if (operator.type !== '=') statement.operator = operator.type === '+=' ? '+' : '-';
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
        const root = viewRoot(expression.object);
        if (root) this.checkModifier(root, expression);
        const args = this.parseCallArguments();
        if (root) this.checkModifierArguments(expression, args);
        const children = [expression, ...args.map((arg) => arg.value)];
        expression = this.owned({ kind: 'call', callee: expression as MemberExpr, args, line: token.line, tokens: 0 }, start, children);
      } else if (expression.kind === 'member' && this.atCallOptions(token)) {
        if (this.declarationKind === 'rendering') {
          throw this.error('A rendering can\'t attach money to calls');
        }
        const options = this.parseCallOptions();
        if (!this.check('(')) {
          throw this.error('Call options must be followed by the call\'s arguments in parentheses');
        }
        const args = this.parseCallArguments();
        const optionValues = [options.amount, options.payees, options.from, options.key].filter((value): value is Expression => value !== undefined);
        const children = [expression, ...optionValues, ...args.map((arg) => arg.value)];
        expression = this.owned({ kind: 'call', callee: expression as MemberExpr, args, options, line: token.line, tokens: 0 }, start, children);
      } else {
        return expression;
      }
    }
  }

  /** A modifier written on a component: one the component takes. */
  private checkModifier(root: ViewExpr, member: MemberExpr): void {
    const spec = MODIFIERS[member.property];
    if (!spec || !Object.hasOwn(MODIFIERS, member.property)) {
      throw new ParseError(`Unknown modifier '${member.property}'`, member.line);
    }
    if (!spec.components.includes(root.component)) {
      throw new ParseError(`${root.component} has no modifier '${member.property}'`, member.line);
    }
  }

  private checkModifierArguments(member: MemberExpr, args: NamedArgument[]): void {
    const spec = MODIFIERS[member.property]!;
    if (args.length !== 1 || args[0]!.name !== spec.arg) {
      throw new ParseError(`Modifier '${member.property}' takes one argument, '${spec.arg}': '.${member.property}(${spec.arg}: ...)'`, member.line);
    }
  }

  /**
   * A component, after its name: `(argument: value, ...)` when it takes arguments, then `{ ... }` holding its
   * children when it takes them. Every argument is required, and an action argument is a lambda.
   */
  private parseView(name: Token, start: number): ViewExpr {
    const spec = COMPONENTS[name.value]!;
    const args: ViewArgument[] = [];
    if (this.check('(') && this.peek().line === name.line) {
      this.advance();
      const seen = new Set<string>();
      while (!this.check(')')) {
        const argToken = this.expect('identifier', 'as an argument name');
        const argSpec = spec.args.find((candidate) => candidate.name === argToken.value);
        if (!argSpec) {
          throw this.error(spec.args.length === 0
            ? `${name.value} takes no arguments`
            : `${name.value} has no argument '${argToken.value}': it takes ${describeArguments(spec)}`, argToken);
        }
        if (seen.has(argToken.value)) throw this.error(`Duplicate argument '${argToken.value}'`, argToken);
        seen.add(argToken.value);
        this.expect(':', 'after the argument name');
        args.push(argSpec.type.kind === 'action'
          ? { name: argToken.value, lambda: this.parseLambda(name.value, argToken.value, argSpec.type) }
          : { name: argToken.value, value: this.parseExpression() });
        if (!this.match(',')) break;
      }
      this.expect(')', `to end the arguments of ${name.value}`);
    }
    for (const argSpec of spec.args) {
      if (!args.some((arg) => arg.name === argSpec.name)) {
        throw new ParseError(`${name.value} needs argument '${argSpec.name}': it takes ${describeArguments(spec)}`, name.line);
      }
    }
    const view: ViewExpr = { kind: 'view', component: name.value, args, line: name.line, tokens: 0 };
    if (this.check('{')) {
      if (!spec.children) throw this.error(`${name.value} has no children`);
      view.children = this.parseBlock();
    }
    const children: object[] = [
      ...args.map((arg) => ('value' in arg ? arg.value : arg.lambda)),
      ...(view.children ?? []),
    ];
    return this.owned(view, start, children);
  }

  /** `(parameter: type, ...) => { ... }`, as action `arg` of `component`, declaring the parameters it is passed, or none. */
  private parseLambda(component: string, arg: string, type: Extract<ViewArgumentType, { kind: 'action' }>): LambdaExpr {
    const start = this.pos;
    const open = this.peek();
    const expected = `(${type.parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join(', ')}) => { ... }`;
    if (open.type !== '(') {
      throw this.error(`Argument '${arg}' of ${component} is an action: write '${expected}'`, open);
    }
    const parameters = this.parseParameterList(true);
    const matches = parameters.length === 0
      || (parameters.length === type.parameters.length && parameters.every((parameter, i) => typeToString(parameter.type) === type.parameters[i]!.type));
    if (!matches) {
      throw this.error(`The action of ${component} is passed ${type.parameters.length === 0 ? 'nothing' : type.parameters.map((parameter) => parameter.type).join(', ')}: write '${expected}'`, open);
    }
    this.expect('=>', 'after the action\'s parameters');
    this.lambdaDepth++;
    const body = this.parseBlock();
    this.lambdaDepth--;
    const lambda: LambdaExpr = { index: this.lambdas.length, parameters, body, names: freeNames(parameters, body), line: open.line, tokens: 0 };
    this.lambdas.push(lambda);
    return this.owned(lambda, start, body);
  }

  /** `{` on the line of the function name, starting `name:`, so it can't be a block or an object on its own line. */
  private atCallOptions(token: Token): boolean {
    return this.check('{') && this.peek().line === token.line && this.peek(1).type === 'identifier' && this.peek(2).type === ':';
  }

  /** `{amount: ..., payees: ..., from: ..., key: ...}`, before a call's arguments: money attached to the call. */
  private parseCallOptions(): CallOptions {
    const open = this.expect('{', 'to start the call options');
    const values = new Map<string, Expression>();
    while (!this.check('}')) {
      const nameToken = this.expect('identifier', 'as a call option');
      if (!['amount', 'payees', 'from', 'key'].includes(nameToken.value)) {
        throw this.error(`Unknown call option '${nameToken.value}': a call takes amount, payees, from and key`, nameToken);
      }
      if (values.has(nameToken.value)) {
        throw this.error(`Duplicate call option '${nameToken.value}'`, nameToken);
      }
      this.expect(':', 'after the call option');
      values.set(nameToken.value, this.parseExpression());
      if (!this.match(',')) break;
    }
    this.expect('}', 'to end the call options');
    const amount = values.get('amount');
    if (!amount) {
      throw this.error('Call options attach money, so they need an amount', open);
    }
    if (this.declarationKind === 'contract') {
      if (!values.has('from')) {
        throw this.error('A contract names whose funding it attaches, with from', open);
      }
    } else {
      if (values.has('from') || values.has('key')) {
        throw this.error('A request script\'s money comes from its run\'s organization, so it names no from or key', open);
      }
      if (!values.has('payees')) {
        throw this.error('A request script that attaches money names the organizations it may be paid to, with payees', open);
      }
    }
    const options: CallOptions = { amount };
    for (const name of ['payees', 'from', 'key'] as const) {
      const value = values.get(name);
      if (value) options[name] = value;
    }
    return options;
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
        if (this.declarationKind === 'rendering' && isComponent(token.value)) {
          return this.parseView(token, start);
        }
        // A name followed by `(` on its line calls one of the contract's functions; nothing else can.
        if (this.check('(') && this.peek().line === token.line) {
          const args = this.parseCallArguments();
          const call: FnCallExpr = { kind: 'fnCall', name: token.value, args, line: token.line, tokens: 0 };
          this.fnCalls.push({ call, caller: this.currentFunction, inLambda: this.lambdaDepth > 0 });
          return this.owned(call, start, args.map((arg) => arg.value));
        }
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
      // The interpolation is parsed in this script's context, so the function calls in it are resolved too.
      const parser = new Parser(part.tokens);
      parser.declarationKind = this.declarationKind;
      parser.currentFunction = this.currentFunction;
      parser.lambdas = this.lambdas;
      parser.lambdaDepth = this.lambdaDepth;
      const expression = parser.parseExpressionToEof();
      this.fnCalls.push(...parser.fnCalls);
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

/** `Text(str: string)`, for error messages. */
function describeArguments(spec: ComponentSpec): string {
  return spec.args.map((arg) => `'${arg.name}'`).join(' and ');
}

/**
 * The names a lambda's body reads that it doesn't declare itself, in the order it first reads them: the ones a
 * render may need to capture for it.
 */
function freeNames(parameters: ParameterDecl[], body: Statement[]): string[] {
  const declared = new Set(parameters.map((parameter) => parameter.name));
  walkStatementsIn(body, (statement) => {
    if (statement.kind === 'varDecl' || statement.kind === 'resourceDecl') declared.add(statement.name);
  });
  const names: string[] = [];
  walkExpressions(body, (expression) => {
    if (expression.kind === 'identifier' && !declared.has(expression.name) && !names.includes(expression.name)) names.push(expression.name);
  });
  return names;
}

/** The variable an assignment's target starts from: `a` in `a`, `a.b` and `a[0].b`. */
function rootName(target: Expression): string | undefined {
  if (target.kind === 'identifier') return target.name;
  if (target.kind === 'member' || target.kind === 'index') return rootName(target.object);
  return undefined;
}

/** The component a chain of modifiers starts from, `Text(...)` in `Text(...).color(...).fontSize(...)`. */
function viewRoot(expression: Expression): ViewExpr | undefined {
  if (expression.kind === 'view') return expression;
  if (expression.kind === 'call') return viewRoot(expression.callee.object);
  return undefined;
}

/** A call that applies a modifier to a component, rather than calling a resource. */
function isModifierCall(expression: Expression): boolean {
  return expression.kind === 'call' && viewRoot(expression.callee.object) !== undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Any word, keywords included, as a path segment may be. */
function isPathWord(token: Token): boolean {
  return token.type === 'identifier' || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token.value);
}

/** Whether `type` names the struct `label` (`path.Name@version`), directly or as a list's element. */
function refersTo(type: TypeNode, label: string): boolean {
  if (type.kind === 'list') return refersTo(type.element, label);
  return type.kind === 'struct' && `${[...type.path, type.name].join('.')}@${type.version}` === label;
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
