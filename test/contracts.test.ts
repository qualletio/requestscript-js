import { describe, expect, it } from 'vitest';
import { EntrypointError, ParameterError, ParseError, RuntimeError } from '../src/lang/errors.js';
import { interpret } from '../src/lang/interpreter.js';
import { run } from './helpers.js';

/** A contract with one entrypoint, `run`, declared by `signature` (parameters and return type) and `body`. */
const single = (signature: string, body: string, path = 'a.C') => `contract ${path} {\n  pub fn run${signature} {\n${body}\n  }\n}`;
const runSingle = (signature: string, body: string, parameters?: Record<string, unknown>) =>
  run(single(signature, body), { function: 'run', ...(parameters ? { parameters } : {}) });

describe('interpreter: entrypoint parameters', () => {
  const greet = single('(name: string): string', 'return "Hello ${name}!"', 'path.to.Greet');

  it('binds parameters into the function', async () => {
    expect(await run(greet, { function: 'run', parameters: { name: 'World' } })).toBe('Hello World!');
  });

  it('rejects missing and unknown parameters', async () => {
    await expect(run(greet, { function: 'run' })).rejects.toThrow(/Missing parameter 'name'/);
    await expect(run(greet, { function: 'run', parameters: {} })).rejects.toThrow(/Missing parameter 'name'/);
    await expect(run(greet, { function: 'run', parameters: { name: 'x', extra: 1 } })).rejects.toThrow(/Unknown parameter 'extra'/);
  });

  it('rejects badly typed parameters with ParameterError', async () => {
    await expect(run(greet, { function: 'run', parameters: { name: 5 } })).rejects.toThrow(ParameterError);
  });

  it('parameters are constants', async () => {
    await expect(runSingle('(x: int32): int32', 'x = 2\nreturn x', { x: 1 })).rejects.toThrow(/const/);
  });

  it('validates and converts numeric parameters', async () => {
    const sum = (parameters: Record<string, unknown>) => runSingle('(a: int32, b: int64): int64', 'return a + b', parameters);
    expect(await sum({ a: 1, b: 2 })).toBe(3);
    // int64 can be passed as a string to preserve precision
    expect(await sum({ a: 1, b: '9223372036854775806' })).toBe('9223372036854775807');
    await expect(sum({ a: 1.5, b: 2 })).rejects.toThrow(ParameterError);
    await expect(sum({ a: 3000000000, b: 2 })).rejects.toThrow(/out of range for int32/);
  });

  it('validates decimal parameters including digit constraints', async () => {
    const double = (price: unknown) => runSingle('(price: decimal(4, 2)): decimal', 'return price * 2', { price });
    expect(await double(12.25)).toBe(24.5);
    expect(await double('0.05')).toBe(0.1);
    await expect(double(12345.0)).rejects.toThrow(/digits before/);
    await expect(double(1.005)).rejects.toThrow(/digits after/);
  });

  it('validates boolean, list, and object parameters', async () => {
    const pick = (parameters: Record<string, unknown>) =>
      runSingle('(flag: boolean, tags: []string, meta: object): string', 'if (flag) { return tags[0] }\nreturn meta.key', parameters);
    expect(await pick({ flag: true, tags: ['a'], meta: { key: 'v' } })).toBe('a');
    expect(await pick({ flag: false, tags: [], meta: { key: 'v' } })).toBe('v');
    await expect(pick({ flag: 'yes', tags: [], meta: {} })).rejects.toThrow(ParameterError);
    await expect(pick({ flag: true, tags: [1], meta: {} })).rejects.toThrow(ParameterError);
    await expect(pick({ flag: true, tags: [], meta: [] })).rejects.toThrow(ParameterError);
  });

  it('supports nested list parameter types', async () => {
    expect(await runSingle('(grid: [][]int32): int32', 'return grid[1][0]', { grid: [[1], [2, 3]] })).toBe(2);
  });

  it('allows null parameter values', async () => {
    expect(await runSingle('(x: string): boolean', 'return x == null', { x: null })).toBe(true);
  });

  it('rejects parameters passed to a request script', async () => {
    await expect(run('request R { return 1 }', { parameters: { x: 1 } })).rejects.toThrow(/does not take parameters/);
  });

  it('runs a parameterless entrypoint without a parameters object', async () => {
    expect(await runSingle('(): string', 'return "ok"')).toBe('ok');
  });
});

describe('interpreter: return types', () => {
  it('returns a value of the declared type, with numeric promotion', async () => {
    expect(await runSingle('(): int32', 'return 2')).toBe(2);
    expect(await runSingle('(): decimal', 'return 2')).toBe(2);
    expect(await runSingle('(): []string', 'return ["a", "b"]')).toEqual(['a', 'b']);
  });

  it('allows null, including a bare return or no return', async () => {
    expect(await runSingle('(): string', 'return null')).toBeNull();
    expect(await runSingle('(): string', 'return')).toBeNull();
    expect(await runSingle('(): string', '')).toBeNull();
  });

  it('rejects a value of another type with RuntimeError', async () => {
    await expect(runSingle('(): int32', 'return "two"')).rejects.toThrow(RuntimeError);
    await expect(runSingle('(): decimal(1, 1)', 'return 2.25')).rejects.toThrow(/returned from function 'run'/);
  });

  it('returns null from a function without a return type, which can\'t return a value', async () => {
    expect(await runSingle('()', 'const x = 1')).toBeNull();
    expect(await runSingle('()', 'return')).toBeNull();
    await expect(runSingle('()', 'return "anything"')).rejects.toThrow(/declares no return type, so it can't return a value/);
  });
});

describe('interpreter: entrypoints', () => {
  const shop = `contract com.example.Shop {
  var state stock: int64 = 3

  fn label(n: int64): string {
    return "\${n} left"
  }

  pub fn buy(n: int64): string {
    if (n > stock) {
      fail "Not enough stock"
    }
    stock = stock - n
    return label(n: stock)
  }

  pub fn count(): int64 {
    return stock
  }
}`;
  const stored = new Map<string, unknown>();
  const state = { get: async (name: string) => (stored.has(name) ? { value: stored.get(name) as number, type: '{"kind":"int64"}' } : undefined) };

  it('runs the pub function the host names, and reports it', async () => {
    const result = await interpret(shop, { function: 'buy', parameters: { n: 2 }, state });
    expect(result.function).toBe('buy');
    expect(result.returnValue).toBe('1 left');
    expect(result.state).toEqual([{ name: 'stock', scope: null, value: { $int64: '1' }, type: '{"kind":"int64"}' }]);
  });

  it('shares state between entrypoints', async () => {
    stored.set('stock', 1);
    expect((await interpret(shop, { function: 'count', state })).returnValue).toBe(1);
    await expect(interpret(shop, { function: 'buy', parameters: { n: 2 }, state })).rejects.toThrow('Not enough stock');
    stored.clear();
  });

  it('needs the host to name a pub function', async () => {
    await expect(interpret(shop, { state })).rejects.toThrow(EntrypointError);
    await expect(interpret(shop, { state })).rejects.toThrow(/Name the function of contract 'com.example.Shop' to run: 'buy', 'count'/);
    await expect(interpret(shop, { function: 'sell', state })).rejects.toThrow(/has no function 'sell'/);
    await expect(interpret(shop, { function: 'label', state })).rejects.toThrow(/isn't pub/);
    await expect(interpret('request R { return 1 }', { function: 'run' })).rejects.toThrow(/Only a contract has functions/);
  });

  it('is an error of the parameters, so hosts can answer it as a bad request', async () => {
    await expect(interpret(shop, { function: 'sell', state })).rejects.toThrow(ParameterError);
  });
});

describe('interpreter: private functions', () => {
  it('calls a function by name with named arguments, in any order, getting its value directly', async () => {
    const source = `contract a.Math {
  pub fn run(x: int64): int64 {
    return add(b: x, a: double(n: x))
  }
  fn add(a: int64, b: int64): int64 {
    return a + b
  }
  fn double(n: int64): int64 {
    return n * 2
  }
}`;
    expect(await run(source, { function: 'run', parameters: { x: 4 } })).toBe(12);
  });

  it('lets a function call a pub function too', async () => {
    const source = 'contract a.C {\n  pub fn one(): int32 {\n    return 1\n  }\n  pub fn two(): int32 {\n    return one() + one()\n  }\n}';
    expect(await run(source, { function: 'two' })).toBe(2);
  });

  it('gives a function the contract\'s state and bindings, but not its caller\'s variables', async () => {
    const source = `contract a.C {
  var state n: int32 = 5
  fn read(): int32 {
    return n
  }
  fn peek(): int32 {
    return local
  }
  pub fn run(): int32 {
    const local = 1
    if (read() == 5) {
      return peek()
    }
    return 0
  }
}`;
    const state = { get: async () => undefined };
    await expect(run(source, { function: 'run', state })).rejects.toThrow(/Unknown variable 'local'/);
  });

  it('checks arguments against the function\'s parameter types', async () => {
    const source = 'contract a.C {\n  fn f(n: int32): int32 {\n    return n\n  }\n  pub fn run(): int32 {\n    return f(n: "x")\n  }\n}';
    await expect(run(source, { function: 'run' })).rejects.toThrow(/for argument 'n' of 'f'/);
  });

  it('fails the run when a function fails', async () => {
    const source = 'contract a.C {\n  fn check() {\n    fail "nope"\n  }\n  pub fn run(): int32 {\n    check()\n    return 1\n  }\n}';
    await expect(run(source, { function: 'run' })).rejects.toThrow('nope');
  });

  it('returns from the function only, not from its caller', async () => {
    const source = 'contract a.C {\n  fn f(): int32 {\n    if (true) {\n      return 1\n    }\n    return 2\n  }\n  pub fn run(): int32 {\n    const x = f()\n    return x + 10\n  }\n}';
    expect(await run(source, { function: 'run' })).toBe(11);
  });

  it('calls functions inside string interpolations', async () => {
    const source = 'contract a.C {\n  fn name(): string {\n    return "Ada"\n  }\n  pub fn run(): string {\n    return "Hi ${name()}"\n  }\n}';
    expect(await run(source, { function: 'run' })).toBe('Hi Ada');
  });
});

describe('parser: contract functions', () => {
  const parse = (source: string) => interpret(source, { function: 'run' });

  it('refuses the old contract-level parameters, return type and payable', async () => {
    await expect(parse('contract a.C(x: int32) { return x }')).rejects.toThrow(/parameters belong to its functions/);
    await expect(parse('contract a.C: int32 { return 1 }')).rejects.toThrow(/return type belongs to its functions/);
    await expect(parse('payable contract a.C { pub fn run() { } }')).rejects.toThrow(/'payable' marks a contract's functions now/);
  });

  it('allows only state, resource bindings and functions outside functions', async () => {
    await expect(parse('contract a.C {\n  return 1\n}')).rejects.toThrow(/Outside its functions a contract declares only/);
    await expect(parse('contract a.C {\n  const x = 1\n  pub fn run() { }\n}')).rejects.toThrow(/Outside its functions/);
    await expect(parse('contract a.C {\n  var x = 1\n  pub fn run() { }\n}')).rejects.toThrow(/Outside its functions/);
  });

  it('needs an entrypoint', async () => {
    await expect(parse('contract a.C {\n  fn helper() { }\n}')).rejects.toThrow(/needs at least one entrypoint/);
    await expect(parse('contract a.C { }')).rejects.toThrow(/needs at least one entrypoint/);
  });

  it('refuses duplicate functions, and a parameter named like a contract-level declaration', async () => {
    await expect(parse('contract a.C {\n  pub fn run() { }\n  fn run() { }\n}')).rejects.toThrow(/Duplicate function 'run'/);
    await expect(parse('contract a.C {\n  var state n = 1\n  pub fn run(n: int32) { }\n}')).rejects.toThrow(/has the name of a contract-level declaration/);
  });

  it('makes payable follow pub', async () => {
    await expect(parse('contract a.C {\n  payable fn run() { }\n}')).rejects.toThrow(/Only a pub function can be payable/);
    await expect(parse('contract a.C {\n  payable pub fn run() { }\n}')).rejects.toThrow(/'pub' comes first/);
  });

  it('checks calls when parsed: the function, its arguments and no recursion', async () => {
    await expect(parse('contract a.C {\n  pub fn run() {\n    missing()\n  }\n}')).rejects.toThrow(ParseError);
    await expect(parse('contract a.C {\n  pub fn run() {\n    missing()\n  }\n}')).rejects.toThrow(/Unknown function 'missing'/);
    await expect(parse('contract a.C {\n  fn f(n: int32) { }\n  pub fn run() {\n    f()\n  }\n}')).rejects.toThrow(/Missing argument 'n' for function 'f'/);
    await expect(parse('contract a.C {\n  fn f() { }\n  pub fn run() {\n    f(x: 1)\n  }\n}')).rejects.toThrow(/Function 'f' has no parameter 'x'/);
    await expect(parse('contract a.C {\n  pub fn run() {\n    run()\n  }\n}')).rejects.toThrow(/Function 'run' calls itself, which a contract can't do: run -> run/);
    await expect(parse('contract a.C {\n  fn a() {\n    b()\n  }\n  fn b() {\n    a()\n  }\n  pub fn run() {\n    a()\n  }\n}')).rejects.toThrow(/a -> b -> a/);
  });

  it('refuses function calls in a request script', async () => {
    await expect(run('request R {\n  return f()\n}')).rejects.toThrow(/A request script has no functions/);
  });

  it('keeps fn and pub reserved', async () => {
    await expect(run('request R {\n  const fn = 1\n  return fn\n}')).rejects.toThrow(ParseError);
    await expect(run('request R {\n  const pub = 1\n  return pub\n}')).rejects.toThrow(ParseError);
  });
});
