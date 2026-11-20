import { describe, expect, it } from 'vitest';
import type { VarDeclStatement } from '../src/lang/ast.js';
import { Decimal } from '../src/lang/decimal.js';
import { ParseError, RuntimeError } from '../src/lang/errors.js';
import { interpret, type StateScope, type StateStore, type StateWrite, type StoredState } from '../src/lang/interpreter.js';
import { maxTokens, TokenMeter } from '../src/lang/meter.js';
import { parseScript } from '../src/lang/parser.js';
import { decodeValue, encodeValue } from '../src/lang/types.js';
import { decimalValue, int64Value, listValue, objectValue, stringValue } from '../src/lang/values.js';

/** A store that keeps writes in memory, as a host would save them after a run. */
class MemoryStore implements StateStore {
  readonly saved = new Map<string, StoredState>();
  private versions = 0;

  private static key(name: string, scope: StateScope): string {
    return scope === null ? name : `${name}/${scope.kind}:${scope.key}`;
  }

  async get(name: string, scope: StateScope): Promise<StoredState | undefined> {
    return this.saved.get(MemoryStore.key(name, scope));
  }

  save(writes: StateWrite[]): void {
    for (const write of writes) {
      this.saved.set(MemoryStore.key(write.name, write.scope), { value: write.value, type: write.type, version: ++this.versions });
    }
  }

  /** Runs `source` and saves its writes, as a host does after a successful run. */
  async run(source: string, parameters?: Record<string, unknown>, builtins?: Record<string, unknown>) {
    const result = await interpret(source, { function: 'run', state: this, parameters, builtins });
    this.save(result.state);
    return result;
  }
}

const counter = 'contract c.Counter {\n  var state count: int32 = 0\n  pub fn run(): int32 {\n    count = count + 1\n    return count\n  }\n}';

describe('state variables: parsing', () => {
  it('parses shared and scoped state declarations', () => {
    const script = parseScript('contract c.C {\n  var state a = 1\n  pub fn run(k: string) {\n    var state(k) b: string = "x"\n  }\n}');
    const [a] = script.body as VarDeclStatement[];
    const [b] = script.functions[0]!.body as VarDeclStatement[];
    expect(a!.state).toEqual({});
    expect(b!.state?.scope).toMatchObject({ kind: 'identifier', name: 'k' });
    expect(b!.type).toEqual({ kind: 'string' });
  });

  it('still parses a variable called state', () => {
    const script = parseScript('request R {\n  var state = 1\n  var other: int32 = state\n  return state\n}');
    expect((script.body[0] as VarDeclStatement).name).toBe('state');
    expect((script.body[0] as VarDeclStatement).state).toBeUndefined();
  });

  it.each([
    ['a const', 'contract c.C {\n  const state a = 1\n}', "declared with 'var'"],
    ['a request', 'request R {\n  var state a = 1\n}', 'only be declared in a contract'],
    ['a nested block', 'contract c.C {\n  pub fn run() {\n    if (true) {\n      var state a = 1\n    }\n  }\n}', 'top level of a function'],
    ['a resource reference', 'contract c.C {\n  var state a: com.example.Weather = 1\n}', 'resource'],
    ['two functions that disagree on its type', 'contract c.C {\n  pub fn a() {\n    var state n: int32 = 0\n  }\n  pub fn b() {\n    var state n: string = ""\n  }\n}', 'every declaration of it must agree'],
    ['two functions that disagree on its scoping', 'contract c.C {\n  pub fn a(k: string) {\n    var state(k) n: int32 = 0\n  }\n  pub fn b() {\n    var state n: int32 = 0\n  }\n}', 'every declaration of it must agree'],
    ['a function, when the top level declares it', 'contract c.C {\n  var state n: int32 = 0\n  pub fn a() {\n    var state n: int32 = 0\n  }\n}', "its functions can't declare it again"],
  ])('refuses state in %s', (_, source, message) => {
    expect(() => parseScript(source)).toThrow(ParseError);
    expect(() => parseScript(source)).toThrow(message);
  });

  it('counts the scope and the initializer in the most tokens a contract can run', () => {
    const plain = maxTokens(parseScript('contract c.C {\n  pub fn run() {\n    var a = 1 + 2\n  }\n}'));
    const scoped = maxTokens(parseScript('contract c.C {\n  var state("k") a = 1 + 2\n  pub fn run() { }\n}'));
    expect(scoped).toBe(plain + 4);
  });
});

describe('state variables: running', () => {
  it('initializes, then keeps a value across runs', async () => {
    const store = new MemoryStore();

    expect((await store.run(counter)).returnValue).toBe(1);
    expect((await store.run(counter)).returnValue).toBe(2);
    expect((await store.run(counter)).returnValue).toBe(3);
  });

  it('returns each variable\'s final value, type and the version it read', async () => {
    const store = new MemoryStore();
    const first = await store.run(counter);
    expect(first.state).toEqual([{ name: 'count', scope: null, value: 1, type: '{"kind":"int32"}' }]);

    const second = await store.run(counter);
    expect(second.state[0]).toMatchObject({ value: 2, version: 1 });
  });

  it('keeps one copy per scope, and scopes keep their kind', async () => {
    const store = new MemoryStore();
    const source = 'contract c.Tally {\n  pub fn run(who: object): int32 {\n    var state(who.key) n: int32 = 0\n    n = n + 1\n    return n\n  }\n}';

    await store.run(source, { who: { key: 'a' } });
    await store.run(source, { who: { key: 'a' } });
    await store.run(source, { who: { key: 3 } });
    expect((await store.run(source, { who: { key: '3' } })).returnValue).toBe(1);

    expect([...store.saved.keys()].sort()).toEqual(['n/integer:3', 'n/string:3', 'n/string:a']);
    expect(store.saved.get('n/string:a')?.value).toBe(2);
  });

  it('runs the initializer only when nothing is stored, and meters it only then', async () => {
    const store = new MemoryStore();
    const source = 'contract c.C {\n  var state n: int32 = 1 + 1 + 1 + 1\n  pub fn run(): int32 {\n    return n\n  }\n}';

    const first = new TokenMeter();
    await interpret(source, { function: 'run', state: store, meter: first }).then((result) => store.save(result.state));
    const second = new TokenMeter();
    await interpret(source, { function: 'run', state: store, meter: second });

    expect(second.tokens).toBe(first.tokens - 7);
  });

  it('saves changes made in place to lists and objects', async () => {
    const store = new MemoryStore();
    const source = 'contract c.Notes {\n  var state notes: object = { items: [] }\n  pub fn run(text: string): object {\n    notes.items = [text]\n    notes.last = text\n    return notes\n  }\n}';

    await store.run(source, { text: 'a' });
    expect((await store.run(source, { text: 'b' })).state[0]!.value).toEqual({ $object: { items: ['b'], last: 'b' } });
  });

  it('lets the initializer read built-ins on first use', async () => {
    const store = new MemoryStore();
    const source = 'contract c.Owned {\n  var state owner: string = caller.org\n  pub fn run(): string {\n    return owner\n  }\n}';

    expect((await store.run(source, undefined, { caller: { org: 'org_a' } })).returnValue).toBe('org_a');
    expect((await store.run(source, undefined, { caller: { org: 'org_b' } })).returnValue).toBe('org_a');
  });

  it('converts a stored value to the declared type, and fails when it doesn\'t fit', async () => {
    const store = new MemoryStore();
    await store.run('contract c.C {\n  var state n: int32 = 5\n  pub fn run() { }\n}');

    expect((await store.run('contract c.C {\n  var state n: int64 = 0\n  pub fn run(): int64 {\n    return n\n  }\n}')).state[0]).toMatchObject({ value: { $int64: '5' } });
    await expect(store.run('contract c.C {\n  var state n: string = ""\n  pub fn run() { }\n}')).rejects.toThrow(/stored value of state variable 'n'/);
  });

  it('keeps an inferred type, including an unconstrained one', async () => {
    const store = new MemoryStore();
    const source = 'contract c.C {\n  var state items = []\n  pub fn run(x: object) {\n    items = [x.v]\n  }\n}';

    await store.run(source, { x: { v: 1 } });
    expect((await store.run(source, { x: { v: 'mixed' } })).state[0]!.value).toEqual(['mixed']);
  });

  it('refuses a scope that isn\'t a string or an integer', async () => {
    await expect(interpret('contract c.C {\n  var state(null) n = 0\n  pub fn run() { }\n}', { function: 'run', state: new MemoryStore() })).rejects.toThrow(RuntimeError);
    await expect(interpret('contract c.C {\n  var state(1.5) n = 0\n  pub fn run() { }\n}', { function: 'run', state: new MemoryStore() })).rejects.toThrow('must be a string or an integer');
  });

  it('needs a host that keeps state', async () => {
    await expect(interpret(counter, { function: 'run' })).rejects.toThrow("needs a host that keeps contract state");
  });

  it('returns no writes when the contract fails', async () => {
    const store = new MemoryStore();
    const failing = 'contract c.C {\n  var state n: int32 = 0\n  pub fn run(d: int32): int32 {\n    n = n + 1\n    return 1 / d\n  }\n}';

    await expect(store.run(failing, { d: 0 })).rejects.toThrow(RuntimeError);
    expect(store.saved.size).toBe(0);
  });

  it('returns no writes for a contract without state', async () => {
    expect((await interpret('contract c.C { pub fn run(): int32 { return 1 } }', { function: 'run', state: new MemoryStore() })).state).toEqual([]);
  });

  it('keys state by name, so a variable declared in two functions is shared across them', async () => {
    const store = new MemoryStore();
    const source = (fn: string) => `contract c.Jobs {
  pub fn ${fn === 'pay' ? 'run' : 'pay'}(job: string): int64 {
    var state(job) paid: int64 = 0
    paid = paid + 5
    return paid
  }
  pub fn ${fn === 'pay' ? 'pay' : 'run'}(job: string): int64 {
    var state(job) paid: int64 = 0
    return paid
  }
}`;
    await store.run(source('pay'), { job: 'j' });
    await store.run(source('pay'), { job: 'j' });
    expect((await store.run(source('read'), { job: 'j' })).returnValue).toBe(10);
  });

  it('binds a variable once per run and scope, even when several functions declare it', async () => {
    const store = new MemoryStore();
    const source = `contract c.Jobs {
  fn credit(job: string) {
    var state(job) paid: int64 = 0
    paid = paid + 1
  }
  pub fn run(job: string): int64 {
    var state(job) paid: int64 = 0
    credit(job: job)
    credit(job: "other")
    return paid
  }
}`;
    const result = await store.run(source, { job: 'j' });
    expect(result.returnValue).toBe(1);
    expect(result.state.map((write) => [write.scope, write.value])).toEqual([
      [{ kind: 'string', key: 'j' }, { $int64: '1' }],
      [{ kind: 'string', key: 'other' }, { $int64: '1' }],
    ]);
  });
});

describe('encodeValue and decodeValue', () => {
  it('round-trip every kind exactly', () => {
    const value = objectValue(new Map([
      ['big', int64Value(9007199254740993n)],
      ['price', decimalValue(Decimal.fromString('2.50'))],
      ['tags', listValue([stringValue('a'), decimalValue(Decimal.fromString('2.0'))])],
      ['$int64', stringValue('not a tag')],
    ]));
    const encoded = encodeValue(value);

    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
    expect(decodeValue(encoded)).toEqual(value);
  });

  it('refuses what it didn\'t write', () => {
    expect(() => decodeValue({ other: 1 })).toThrow('Invalid encoded value');
    expect(() => decodeValue(1.5)).toThrow('Invalid encoded value');
  });
});
