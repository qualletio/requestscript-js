import { describe, expect, it } from 'vitest';
import type { Expression, Script, Statement } from '../src/lang/ast.js';
import { RuntimeError } from '../src/lang/errors.js';
import { createResourceResolver, interpret } from '../src/lang/interpreter.js';
import { tokenize } from '../src/lang/lexer.js';
import { maxTokens, TokenLimitError, TokenMeter } from '../src/lang/meter.js';
import { parseScript } from '../src/lang/parser.js';
import type { Resource, ResourceFunctionCallParameter } from '../src/lang/resource.js';
import type { Token } from '../src/lang/token.js';

const request = (body: string) => `request R {\n${body}\n}`;

/** `request R { }` owns none of the script's tokens. */
const HEADER_TOKENS = 4;

/** Every lexer token in the source, counting the tokens inside string interpolations. */
function sourceTokens(tokens: Token[]): number {
  return tokens.reduce((sum, token) => {
    if (token.type === 'eof') return sum;
    const nested = (token.parts ?? []).reduce((n, part) => n + (part.type === 'expr' ? sourceTokens(part.tokens) : 0), 0);
    return sum + 1 + nested;
  }, 0);
}

/** The tokens owned by every node of the script, whether or not it would run. */
function ownedTokens(script: Script): number {
  const statement = (s: Statement): number => {
    switch (s.kind) {
      case 'varDecl':
        return s.tokens + expression(s.value);
      case 'resourceDecl':
        return s.tokens;
      case 'assign':
        return s.tokens + expression(s.target) + expression(s.value);
      case 'return':
        return s.tokens + (s.value ? expression(s.value) : 0);
      case 'exprStmt':
        return s.tokens + expression(s.expression);
      case 'if':
        return (
          s.tokens +
          s.branches.reduce((sum, b) => sum + b.tokens + expression(b.condition) + block(b.body), 0) +
          (s.elseTokens ?? 0) +
          block(s.elseBody ?? [])
        );
    }
  };
  const block = (statements: Statement[]) => statements.reduce((sum, s) => sum + statement(s), 0);
  const expression = (e: Expression): number => {
    const sum = (children: Expression[]) => children.reduce((n, child) => n + expression(child), 0);
    switch (e.kind) {
      case 'templateString':
        return e.tokens + sum(e.parts.flatMap((part) => (part.type === 'expr' ? [part.expression] : [])));
      case 'objectLiteral':
        return e.tokens + sum(e.entries.map((entry) => entry.value));
      case 'listLiteral':
        return e.tokens + sum(e.elements);
      case 'member':
        return e.tokens + sum([e.object]);
      case 'index':
        return e.tokens + sum([e.object, e.index]);
      case 'call':
        return e.tokens + sum([e.callee, ...e.args.map((arg) => arg.value)]);
      case 'unary':
        return e.tokens + sum([e.operand]);
      case 'binary':
        return e.tokens + sum([e.left, e.right]);
      default:
        return e.tokens;
    }
  };
  return block(script.body);
}

async function executedTokens(body: string, resources: Resource[] = []): Promise<number> {
  const result = await interpret(request(body), { resourceResolver: createResourceResolver(resources) });
  return result.usage.tokens;
}

function arg(args: ResourceFunctionCallParameter[], name: string): unknown {
  return args.find((parameter) => parameter.name === name)?.value;
}

const addResource: Resource = {
  path: 'path.to',
  name: 'AddResource',
  functions: [
    {
      name: 'add',
      parameters: [
        { name: 'first', type: 'int32' },
        { name: 'second', type: 'int32' },
      ],
      exec: async (args) => Number(arg(args, 'first')) + Number(arg(args, 'second')),
      returnType: 'int32',
    },
  ],
};

describe('token ownership', () => {
  const bodies = [
    'return 1 + 2 * 3',
    'return (1 + 2) * -3',
    'var a: decimal(5, 2) = 1.5\nconst b: []string = ["x", "y",]\nreturn b[0]',
    'var o = { a: 1, b: { c: true }, }\no.a = 2\no.b.c = !o.b.c\nreturn o',
    'const r: path.to.AddResource\nr.add(first: 1, second: 2)\nreturn r.add(first: 3, second: 4).value',
    'var s = "a ${1 + "b ${2 * 3}"} c"\nreturn s',
    'var x = 1\nif (x > 1) { return 1 } else if (x == 1 && true) { if (false) { return 2 } } else { return 3 }',
    'return\nreturn null',
  ];

  it.each(bodies)('assigns every body token to exactly one node: %s', (body) => {
    const source = request(body);
    expect(ownedTokens(parseScript(source))).toBe(sourceTokens(tokenize(source)) - HEADER_TOKENS);
  });

  it('owns no tokens in a contract declaration or its parameters', () => {
    const script = parseScript('contract a.b.C@2(p: string, q: [][]int32) { return p }');
    expect(ownedTokens(script)).toBe(2);
  });

  it('counts a string as one token whatever its length', () => {
    expect(ownedTokens(parseScript(request('return "a long string with many words"')))).toBe(2);
  });
});

describe('executed tokens', () => {
  it('reports the tokens a script executed', async () => {
    expect(await executedTokens('return 1 + 2')).toBe(4);
  });

  it('charges only the branch taken and the conditions evaluated', async () => {
    // var x = <value>: 4 tokens. if ( ) { }: 5, x: 1, return 1: 2. else { }: 3, return 2: 2.
    const body = (x: boolean) => `var x = ${x}\nif (x) { return 1 } else { return 2 }`;
    expect(await executedTokens(body(true))).toBe(4 + 6 + 2);
    expect(await executedTokens(body(false))).toBe(4 + 6 + 3 + 2);
    expect(maxTokens(parseScript(request(body(true))))).toBe(15);
  });

  it('charges each else-if condition it evaluates', async () => {
    // var x = n: 4. if ( ) { }: 5, x == 1: 3, return "a": 2. else if ( ) { }: 6, x == 2: 3, return "b": 2.
    const body = (n: number) => `var x = ${n}\nif (x == 1) { return "a" } else if (x == 2) { return "b" }\nreturn "c"`;
    expect(await executedTokens(body(1))).toBe(4 + 8 + 2);
    expect(await executedTokens(body(2))).toBe(4 + 8 + 9 + 2);
    expect(await executedTokens(body(3))).toBe(4 + 8 + 9 + 2);
  });

  it('skips the operand a short circuit does not evaluate', async () => {
    // return: 1, && with the parentheses: 3, false: 1. The division never runs.
    expect(await executedTokens('return false && (1 / 0 == 1)')).toBe(5);
    expect(await executedTokens('return true || (1 / 0 == 1)')).toBe(5);
  });

  it('charges interpolated expressions', async () => {
    expect(await executedTokens('return "a ${1 + 2}"')).toBe(5);
  });

  it('charges resource calls, their callee and their arguments', async () => {
    const body = 'const r: path.to.AddResource\nreturn r.add(first: 1, second: 2)';
    expect(await executedTokens(body, [addResource])).toBe(21);
  });

  it('charges assignment targets', async () => {
    expect(await executedTokens('var o = { a: 1 }\no.a = 2\nvar l = [1]\nl[0] = 2')).toBe(8 + 5 + 6 + 6);
  });

  it('never executes more than maxTokens', async () => {
    const body = (x: number) =>
      `var x = ${x}\nif (x > 1 || x < -1) { return "big" } else if (x == 0) { return "zero" } else { var y = x * 2\nreturn "${'${y}'}" }`;
    for (const x of [-2, 0, 1, 2]) {
      expect(await executedTokens(body(x))).toBeLessThanOrEqual(maxTokens(parseScript(request(body(x)))));
    }
    // The else branch is the costliest path.
    expect(await executedTokens(body(1))).toBe(maxTokens(parseScript(request(body(1)))));
  });
});

describe('TokenMeter', () => {
  it('stops a script before the node that would pass its limit', async () => {
    const meter = new TokenMeter(5);
    await expect(interpret(request('var x = 1\nvar y = 2\nreturn x'), { meter })).rejects.toThrow(TokenLimitError);
    expect(meter.tokens).toBe(4);
  });

  it('allows a script that uses exactly its limit', async () => {
    const result = await interpret(request('return 1 + 2'), { meter: new TokenMeter(4) });
    expect(result.usage.tokens).toBe(4);
  });

  it('keeps the count of a run that failed', async () => {
    const meter = new TokenMeter();
    await expect(interpret(request('var x = 1 / 0'), { meter })).rejects.toThrow(RuntimeError);
    expect(meter.tokens).toBe(6);
  });

  it('stops a script once its signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const meter = new TokenMeter();
    await expect(interpret(request('return 1'), { meter, signal: controller.signal })).rejects.toThrow();
    expect(meter.tokens).toBe(0);
  });
});
