import { describe, expect, it } from 'vitest';
import type { ContractDecl, ResourceDeclStatement, StructDecl, VarDeclStatement } from '../src/lang/ast.js';
import { ParameterError, ParseError, RuntimeError } from '../src/lang/errors.js';
import { createResourceResolver, interpret, type EventResolver, type StateStore, type StoredState } from '../src/lang/interpreter.js';
import { parseScript, parseTypeString } from '../src/lang/parser.js';
import type { Resource } from '../src/lang/resource.js';
import {
  createStructResolver,
  MAX_STRUCT_DEPTH,
  structReferences,
  structType,
  typeStructReferences,
  type StructResolver,
  type StructType,
} from '../src/lang/structs.js';
import { typeToString } from '../src/lang/types.js';
import { runBody } from './helpers.js';

const address: StructType = {
  path: 'com.example',
  name: 'Address',
  version: '1',
  fields: [
    { name: 'street', type: 'string' },
    { name: 'zip', type: 'int32' },
  ],
};

const customer: StructType = {
  path: 'com.example',
  name: 'Customer',
  version: '2',
  fields: [
    { name: 'name', type: 'string' },
    { name: 'addresses', type: '[]com.example.Address@1' },
    { name: 'credit', type: 'decimal' },
  ],
};

const structs = createStructResolver([address, customer]);

/** Counts lookups, to show each struct is resolved once per run. */
function countingResolver(inner: StructResolver): StructResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (path, name, version) => {
      calls.push(`${path}.${name}@${version}`);
      return inner.resolve(path, name, version);
    },
  };
}

describe('structs: parsing', () => {
  it('parses a struct declaration', () => {
    const script = parseScript('struct com.example.Customer@2(name: string, addresses: []com.example.Address@1)');
    expect(script.body).toEqual([]);
    expect(script.declaration).toEqual<StructDecl>({
      kind: 'struct',
      path: ['com', 'example'],
      name: 'Customer',
      version: '2',
      fields: [
        { name: 'name', type: { kind: 'string' } },
        { name: 'addresses', type: { kind: 'list', element: { kind: 'struct', path: ['com', 'example'], name: 'Address', version: '1' } } },
      ],
    });
  });

  it('parses a dotted version', () => {
    expect(parseScript('struct a.S@1.2.3(x: int32)').declaration).toMatchObject({ version: '1.2.3' });
  });

  it.each([
    ['no version', 'struct a.S(x: int32)', "must declare its version, e.g. 'struct a.S@1(...)'"],
    ['no fields', 'struct a.S@1', 'must declare its fields'],
    ['empty fields', 'struct a.S@1()', 'must not be empty'],
    ['a body', 'struct a.S@1(x: int32) { }', 'no body'],
    ['a body without fields', 'struct a.S@1 { }', 'no body'],
    ['a return type', 'struct a.S@1(x: int32): string', 'return type'],
    ['a duplicate field', 'struct a.S@1(x: int32, x: string)', "Duplicate parameter 'x'"],
    ['a field of itself', 'struct a.S@1(next: a.S@1)', "can't refer to itself, as field 'next' does"],
    ['a list of itself', 'struct a.S@1(children: [][]a.S@1)', "can't refer to itself"],
    ['an unversioned struct field', 'struct a.S@1(other: a.T)', "Struct type 'a.T' must name its version, e.g. 'a.T@1'"],
  ])('refuses a struct with %s', (_, source, message) => {
    expect(() => parseScript(source)).toThrow(ParseError);
    expect(() => parseScript(source)).toThrow(message);
  });

  it('allows a field of another version of itself', () => {
    expect(() => parseScript('struct a.S@2(previous: a.S@1)')).not.toThrow();
  });

  it('parses struct types in contract parameters and return types', () => {
    const declaration = parseScript('contract a.C(c: com.example.Customer@2): []com.example.Address@1 { }').declaration as ContractDecl;
    expect(declaration.parameters[0]!.type).toEqual({ kind: 'struct', path: ['com', 'example'], name: 'Customer', version: '2' });
    expect(declaration.returnType).toEqual({ kind: 'list', element: { kind: 'struct', path: ['com', 'example'], name: 'Address', version: '1' } });
  });

  it('parses a struct-typed var, and still a resource reference without a version', () => {
    const [typed, resource] = parseScript('request R {\n var a: com.example.Address@1 = null\n const r: com.example.Weather\n}').body;
    expect((typed as VarDeclStatement).type).toEqual({ kind: 'struct', path: ['com', 'example'], name: 'Address', version: '1' });
    expect((resource as ResourceDeclStatement).kind).toBe('resourceDecl');
  });

  it('explains an unversioned struct type in a var', () => {
    expect(() => parseScript('request R {\n var a: com.example.Address = null\n}')).toThrow(
      "Unknown type 'com.example.Address': a struct type must name its version, e.g. 'com.example.Address@1'",
    );
  });

  it('keeps unknown single-word types as they were', () => {
    expect(() => parseScript('request R {\n var a: foo = 1\n}')).toThrow("Unknown type 'foo'");
    expect(() => parseTypeString('foo')).toThrow("Invalid type 'foo'");
  });

  it('parses struct type strings, and round-trips them', () => {
    const type = parseTypeString('[]com.example.Address@1.5');
    expect(type).toEqual({ kind: 'list', element: { kind: 'struct', path: ['com', 'example'], name: 'Address', version: '1.5' } });
    expect(typeToString(type)).toBe('[]com.example.Address@1.5');
    expect(() => parseTypeString('com.example.Address')).toThrow("Invalid type 'com.example.Address'");
  });

  it("doesn't reserve 'struct'", async () => {
    expect(await runBody('var struct = 1\nreturn struct')).toBe(1);
  });

  it('turns a declaration into the struct a host stores', () => {
    const declaration = parseScript('struct com.example.Customer@2(name: string, addresses: []com.example.Address@1, credit: decimal(10, 2))').declaration as StructDecl;
    expect(structType(declaration)).toEqual({
      path: 'com.example',
      name: 'Customer',
      version: '2',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'addresses', type: '[]com.example.Address@1' },
        { name: 'credit', type: 'decimal(10, 2)' },
      ],
    });
  });
});

describe('structs: references', () => {
  it('lists the structs a script names, once each, in source order', () => {
    const script = parseScript(`contract a.C(c: com.example.Customer@2): com.example.Address@1 {
      var x: []com.example.Address@1 = []
      if (true) { var y: b.Other@3 = null } else { var z: [][]b.Else@1 = [] }
    }`);
    expect(structReferences(script).map(typeToString)).toEqual([
      'com.example.Customer@2',
      'com.example.Address@1',
      'b.Other@3',
      'b.Else@1',
    ]);
  });

  it("lists a struct's and an event's fields", () => {
    expect(structReferences(parseScript('struct a.S@1(x: b.T@1, y: []b.U@2)')).map(typeToString)).toEqual(['b.T@1', 'b.U@2']);
    expect(structReferences(parseScript('event a.E(x: b.T@1)')).map(typeToString)).toEqual(['b.T@1']);
  });

  it('lists the structs in a type', () => {
    expect(typeStructReferences(parseTypeString('[]a.S@1')).map(typeToString)).toEqual(['a.S@1']);
    expect(typeStructReferences(parseTypeString('int32'))).toEqual([]);
  });
});

describe('structs: checking values', () => {
  it('keeps declared fields, sets missing ones to null and keeps undeclared ones', async () => {
    const value = await runBody('var a: com.example.Address@1 = { street: "Main", extra: true }\nreturn a', { structs });
    expect(value).toEqual({ street: 'Main', extra: true, zip: null });
  });

  it('converts fields to their types', async () => {
    const value = await runBody('var c: com.example.Customer@2 = { name: "Ana", credit: 5, addresses: [{ street: "Main", zip: 1 }] }\nreturn c', { structs });
    expect(value).toEqual({ name: 'Ana', credit: 5, addresses: [{ street: 'Main', zip: 1 }] });
  });

  it('refuses a field of the wrong type, naming it', async () => {
    const run = runBody('var a: com.example.Address@1 = { street: 5 }', { structs });
    await expect(run).rejects.toThrow(RuntimeError);
    await expect(run).rejects.toThrow("Cannot use a int32 value as string for field 'street' of com.example.Address@1 in the declaration of 'a'");
  });

  it('checks nested structs in lists', async () => {
    const run = runBody('var c: com.example.Customer@2 = { addresses: [{ zip: "x" }] }', { structs });
    await expect(run).rejects.toThrow("for field 'zip' of com.example.Address@1 for field 'addresses' of com.example.Customer@2");
  });

  it('refuses a value that is not an object', async () => {
    await expect(runBody('var a: com.example.Address@1 = [1]', { structs })).rejects.toThrow('as com.example.Address@1');
  });

  it('allows null', async () => {
    expect(await runBody('var a: com.example.Address@1 = null\nreturn a', { structs })).toBeNull();
  });

  it('checks assignments to a struct-typed variable', async () => {
    const run = runBody('var a: com.example.Address@1 = null\na = { zip: true }', { structs });
    await expect(run).rejects.toThrow("for field 'zip' of com.example.Address@1 in assignment to 'a'");
  });

  it('is structural: a value of one struct fits another with the same fields', async () => {
    const other = { ...address, path: 'b', name: 'Place' };
    const resolver = createStructResolver([address, other]);
    expect(await runBody('var a: com.example.Address@1 = { street: "x" }\nvar p: b.Place@1 = a\nreturn p', { structs: resolver }))
      .toEqual({ street: 'x', zip: null });
  });

  it('checks contract parameters and return values', async () => {
    const source = 'contract a.Ship(c: com.example.Customer@2): com.example.Address@1 {\n return c.addresses[0]\n}';
    const result = await interpret(source, { structs, parameters: { c: { name: 'Ana', addresses: [{ street: 'Main', zip: '7' }] } } });
    expect(result.returnValue).toEqual({ street: 'Main', zip: 7 });

    const bad = interpret(source, { structs, parameters: { c: { addresses: [{ zip: 'x' }] } } });
    await expect(bad).rejects.toThrow(ParameterError);
    await expect(bad).rejects.toThrow("for parameter 'c'.addresses[0].zip");

    const returned = interpret('contract a.R: com.example.Address@1 {\n return { zip: "x" }\n}', { structs });
    await expect(returned).rejects.toThrow('returned from the contract');
  });

  it('checks resource arguments and return values', async () => {
    const seen: unknown[] = [];
    const geo: Resource = {
      metadata: {},
      path: 'com.example',
      name: 'Geo',
      functions: [{
        name: 'lookup',
        parameters: [{ name: 'at', type: 'com.example.Address@1' }],
        returnType: 'com.example.Address@1',
        exec: async (args) => {
          seen.push(args[0]!.value);
          return { street: 'Found', zip: 2, note: 'kept' };
        },
      }],
    };
    const value = await runBody('const geo: com.example.Geo\nreturn geo.lookup(at: { street: "Main" })', {
      structs,
      resourceResolver: createResourceResolver([geo]),
    });
    expect(seen).toEqual([{ street: 'Main', zip: null }]);
    expect(value).toEqual({ value: { street: 'Found', zip: 2, note: 'kept' }, error: null });
  });

  it('checks emitted event fields', async () => {
    const events: EventResolver = {
      resolve: async () => ({ path: 'a', name: 'Moved', version: '1', fields: [{ name: 'to', type: 'com.example.Address@1' }] }),
    };
    const result = await interpret('request R {\n emit a.Moved(to: { street: "Main" })\n}', { structs, events });
    expect(result.events[0]!.data).toEqual({ to: { street: 'Main', zip: null } });
    await expect(interpret('request R {\n emit a.Moved(to: { zip: "x" })\n}', { structs, events })).rejects.toThrow("for field 'zip' of com.example.Address@1");
  });

  it('checks the fields of a consumed event', async () => {
    const events: EventResolver = {
      resolve: async () => ({ path: 'a', name: 'Moved', version: '1', fields: [{ name: 'to', type: 'com.example.Address@1' }] }),
    };
    const result = await interpret('contract a.OnMoved consumes a.Moved {\n var zip = to.zip\n}', { structs, events, parameters: { to: { zip: 3 } } });
    expect(result.returnValue).toBeNull();
    await expect(interpret('contract a.OnMoved consumes a.Moved { }', { structs, events, parameters: { to: { zip: 'x' } } })).rejects.toThrow(ParameterError);
  });

  it('keeps state variables of struct types', async () => {
    const saved = new Map<string, StoredState>();
    const state: StateStore = { get: async (name) => saved.get(name) };
    const source = 'contract a.Last(street: string): com.example.Address@1 {\n var state last: com.example.Address@1 = null\n var previous = last\n last = { street: street }\n return previous\n}';
    for (const write of (await interpret(source, { structs, state, parameters: { street: 'One' } })).state) {
      saved.set(write.name, { value: write.value, type: write.type });
    }
    const second = await interpret(source, { structs, state, parameters: { street: 'Two' } });
    expect(second.returnValue).toEqual({ street: 'One', zip: null });
  });
});

describe('structs: resolving', () => {
  it('fails before running when a named struct is unknown', async () => {
    const calls: string[] = [];
    const log: Resource = { metadata: {}, path: 'a', name: 'Log', functions: [{ name: 'write', parameters: [], returnType: 'void', exec: async () => { calls.push('write'); } }] };
    const run = runBody('const log: a.Log\nlog.write()\nif (false) { var x: a.Missing@1 = null }', {
      structs,
      resourceResolver: createResourceResolver([log]),
    });
    await expect(run).rejects.toThrow("Unknown struct 'a.Missing@1'");
    expect(calls).toEqual([]);
  });

  it('refuses a struct type without a resolver', async () => {
    await expect(runBody('var a: com.example.Address@1 = null')).rejects.toThrow("Struct 'com.example.Address@1' needs a host that resolves structs");
  });

  it('resolves only the version named', async () => {
    const run = runBody('var a: com.example.Address@2 = null', { structs });
    await expect(run).rejects.toThrow("Unknown struct 'com.example.Address@2'");
  });

  it('resolves each struct once per run, with the structs its fields name', async () => {
    const resolver = countingResolver(structs);
    await runBody('var c: com.example.Customer@2 = null\nvar a: com.example.Address@1 = null\nvar d: []com.example.Customer@2 = []', { structs: resolver });
    expect(resolver.calls).toEqual(['com.example.Customer@2', 'com.example.Address@1']);
  });

  it('refuses a struct that contains itself', async () => {
    const resolver = createStructResolver([
      { path: 'a', name: 'A', version: '1', fields: [{ name: 'b', type: 'a.B@1' }] },
      { path: 'a', name: 'B', version: '1', fields: [{ name: 'a', type: '[]a.A@1' }] },
    ]);
    await expect(runBody('var x: a.A@1 = null', { structs: resolver })).rejects.toThrow("Struct 'a.A@1' contains itself: a.A@1 -> a.B@1 -> a.A@1");
  });

  it(`refuses structs nested more than ${MAX_STRUCT_DEPTH} deep`, async () => {
    const chain = (depth: number) => Array.from({ length: depth }, (_, i): StructType => ({
      path: 'd',
      name: `S${i}`,
      version: '1',
      fields: i === depth - 1 ? [{ name: 'x', type: 'int32' }] : [{ name: 'next', type: `d.S${i + 1}@1` }],
    }));
    await expect(runBody('var x: d.S0@1 = null', { structs: createStructResolver(chain(MAX_STRUCT_DEPTH)) })).resolves.toBeNull();
    await expect(runBody('var x: d.S0@1 = null', { structs: createStructResolver(chain(MAX_STRUCT_DEPTH + 1)) })).rejects.toThrow(
      `Struct 'd.S0@1' nests more than ${MAX_STRUCT_DEPTH} structs deep`,
    );
  });

  it('refuses a struct with an invalid field type', async () => {
    const resolver = createStructResolver([{ path: 'a', name: 'S', version: '1', fields: [{ name: 'x', type: 'a.T' }] }]);
    await expect(runBody('var x: a.S@1 = null', { structs: resolver })).rejects.toThrow("Struct 'a.S@1' declares an invalid type 'a.T' for field 'x'");
  });

  it('refuses a resource whose types name an unknown struct when it is called', async () => {
    const calls: string[] = [];
    const geo: Resource = { metadata: {}, path: 'a', name: 'Geo', functions: [{ name: 'get', parameters: [], returnType: 'a.Missing@1', exec: async () => { calls.push('get'); return {}; } }] };
    const run = runBody('const geo: a.Geo\nreturn geo.get()', { structs, resourceResolver: createResourceResolver([geo]) });
    await expect(run).rejects.toThrow("Unknown struct 'a.Missing@1' (line 3)");
    expect(calls).toEqual([]);
  });

  it("doesn't run a struct declaration", async () => {
    await expect(interpret('struct a.S@1(x: int32)', { structs })).rejects.toThrow('does not run');
  });
});
