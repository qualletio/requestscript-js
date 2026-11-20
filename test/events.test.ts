import { describe, expect, it } from 'vitest';
import type { ContractDecl, EmitStatement, EventDecl, IfStatement } from '../src/lang/ast.js';
import { ParameterError, ParseError, RuntimeError } from '../src/lang/errors.js';
import { emittedEvents } from '../src/lang/events.js';
import { entrypoints } from '../src/lang/functions.js';
import { interpret, type EventResolver, type EventType } from '../src/lang/interpreter.js';
import { maxTokens, TokenMeter } from '../src/lang/meter.js';
import { parseScript } from '../src/lang/parser.js';

const greeted: EventType = {
  path: 'com.example',
  name: 'Greeted',
  version: '2',
  fields: [
    { name: 'who', type: 'string' },
    { name: 'times', type: 'int64' },
  ],
};

/** Resolves only `com.example.Greeted`, at version 2 or any version. */
const resolver: EventResolver = {
  resolve: async (path, name, version) =>
    path === greeted.path && name === greeted.name && (version === undefined || version === greeted.version) ? greeted : undefined,
};

describe('events: parsing', () => {
  it('parses an event declaration', () => {
    const script = parseScript('event com.example.Greeted@2(who: string, times: int64)');
    expect(script.body).toEqual([]);
    expect(script.declaration).toEqual<EventDecl>({
      kind: 'event',
      path: ['com', 'example'],
      name: 'Greeted',
      version: '2',
      fields: [
        { name: 'who', type: { kind: 'string' } },
        { name: 'times', type: { kind: 'int64' } },
      ],
      restricted: false,
    });
  });

  it('parses a restricted event without fields, at version 1', () => {
    const script = parseScript('restricted event com.example.Tick');
    expect(script.declaration).toMatchObject({ kind: 'event', name: 'Tick', version: '1', fields: [], restricted: true });
  });

  it.each([
    ['a body', 'event a.E(x: string) { }', 'no body'],
    ['a return type', 'event a.E(x: string): string', 'return type'],
    ['a duplicate field', 'event a.E(x: string, x: int32)', "Duplicate parameter 'x'"],
  ])('refuses an event with %s', (_, source, message) => {
    expect(() => parseScript(source)).toThrow(ParseError);
    expect(() => parseScript(source)).toThrow(message);
  });

  it('parses an event contract and its handler', () => {
    const script = parseScript('contract com.example.OnGreeted@3 consumes com.example.Greeted@2 {\n  fn on(who: string) { }\n}');
    const declaration = script.declaration as ContractDecl;
    expect(declaration).toEqual({ kind: 'contract', path: ['com', 'example'], name: 'OnGreeted', version: '3', consumes: { path: ['com', 'example'], name: 'Greeted', version: '2' } });
    expect(script.functions[0]).toMatchObject({ name: 'on', pub: false, parameters: [{ name: 'who', type: { kind: 'string' } }] });
    expect(entrypoints(script).map((fn) => fn.name)).toEqual(['on']);
  });

  it('parses an event contract without a pinned version', () => {
    const declaration = parseScript('contract c.On consumes com.example.Greeted { fn on() { } }').declaration as ContractDecl;
    expect(declaration.consumes).toEqual({ path: ['com', 'example'], name: 'Greeted' });
  });

  it.each([
    ['parameters', 'contract c.On consumes a.E(x: string) { fn on() { } }', "declare 'fn on(field: type, ...)'"],
    ['a return type', 'contract c.On consumes a.E: string { fn on() { } }', "declare 'fn on(field: type, ...)'"],
    ['no handler', 'contract c.On consumes a.E {\n  fn helper() { }\n}', 'needs a handler'],
    ['a pub handler', 'contract c.On consumes a.E {\n  pub fn on() { }\n}', "isn't pub"],
    ['a handler with a return type', 'contract c.On consumes a.E {\n  fn on(): int32 { }\n}', 'has no return type'],
    ['a return value', 'contract c.On consumes a.E {\n  fn on() {\n    return 1\n  }\n}', 'cannot return a value'],
    ['a pub function', 'contract c.On consumes a.E {\n  fn on() { }\n  pub fn other() { }\n}', "can't be pub"],
    ['a call to its handler', 'contract c.On consumes a.E {\n  fn on() { }\n  fn other() {\n    on()\n  }\n}', "it can't be called"],
  ])('refuses an event contract with %s', (_, source, message) => {
    expect(() => parseScript(source)).toThrow(message);
  });

  it('refuses a handler named on in a contract that consumes nothing', () => {
    expect(() => parseScript('contract c.C {\n  fn on() { }\n  pub fn run() { }\n}')).toThrow('handler of event contracts');
  });

  it('allows a bare return, and private helpers, in an event contract', () => {
    expect(() => parseScript('contract c.On consumes a.E {\n  fn helper() { }\n  fn on() {\n    helper()\n    return\n  }\n}')).not.toThrow();
  });

  it('parses emit statements, in branches too', () => {
    const script = parseScript('request R {\n  emit com.example.Greeted@2(who: "a", times: 1)\n  if (true) {\n    emit a.Tick()\n  }\n}');
    const emit = script.body[0] as EmitStatement;
    expect(emit.kind).toBe('emit');
    expect(emit.event).toEqual({ path: ['com', 'example'], name: 'Greeted', version: '2' });
    expect(emit.args.map((arg) => arg.name)).toEqual(['who', 'times']);
    expect((script.body[1] as IfStatement).branches[0]!.body[0]!.kind).toBe('emit');
    expect(emittedEvents(script)).toEqual([
      { path: ['com', 'example'], name: 'Greeted', version: '2' },
      { path: ['a'], name: 'Tick' },
    ]);
  });

  it('keeps emit, event, consumes and restricted usable as names', () => {
    const source = 'request R {\n  var emit = 1\n  var event = { consumes: 2 }\n  var restricted = emit + event.consumes\n  return restricted\n}';
    expect(parseScript(source).body.map((statement) => statement.kind)).toEqual(['varDecl', 'varDecl', 'varDecl', 'return']);
  });

  it('still asks for a declaration first', () => {
    expect(() => parseScript('foo { }')).toThrow("must start with 'request', 'contract', 'event' or 'struct'");
  });
});

describe('events: emitting', () => {
  it('returns the events a run emits, with their data as JSON', async () => {
    const result = await interpret(
      'request R {\n  var name = "Ada"\n  emit com.example.Greeted(times: 3, who: name)\n  emit com.example.Greeted@2(who: "Bob", times: 9007199254740993)\n  return 1\n}',
      { events: resolver },
    );
    expect(result.events).toEqual([
      { path: 'com.example', name: 'Greeted', version: '2', data: { who: 'Ada', times: 3 } },
      { path: 'com.example', name: 'Greeted', version: '2', data: { who: 'Bob', times: '9007199254740993' } },
    ]);
  });

  it('returns no events without an emit', async () => {
    expect((await interpret('request R { return 1 }')).events).toEqual([]);
  });

  it('emits from a contract, and finds the emits in its functions', async () => {
    const source = 'contract c.C {\n  fn greet(who: string) {\n    emit com.example.Greeted(who: who, times: 1)\n  }\n  pub fn run(who: string) {\n    greet(who: who)\n  }\n}';
    expect(emittedEvents(parseScript(source))).toEqual([{ path: ['com', 'example'], name: 'Greeted' }]);
    const result = await interpret(source, {
      function: 'run',
      events: resolver,
      parameters: { who: 'Ada' },
    });
    expect(result.events).toEqual([{ path: 'com.example', name: 'Greeted', version: '2', data: { who: 'Ada', times: 1 } }]);
  });

  it.each([
    ['without a host', 'emit com.example.Greeted(who: "a", times: 1)', undefined, 'needs a host that publishes events'],
    ['an unknown event', 'emit com.example.Missing(who: "a")', resolver, "Unknown event 'com.example.Missing'"],
    ['an unknown version', 'emit com.example.Greeted@3(who: "a", times: 1)', resolver, "Unknown event 'com.example.Greeted@3'"],
    ['an unknown field', 'emit com.example.Greeted(who: "a", times: 1, extra: 2)', resolver, "no field 'extra'"],
    ['a missing field', 'emit com.example.Greeted(who: "a")', resolver, "Missing field 'times'"],
    ['a field of the wrong type', 'emit com.example.Greeted(who: 1, times: 1)', resolver, "field 'who'"],
  ])('fails to emit %s', async (_, body, events, message) => {
    const run = interpret(`request R {\n  ${body}\n}`, events ? { events } : {});
    await expect(run).rejects.toThrow(RuntimeError);
    await expect(interpret(`request R {\n  ${body}\n}`, events ? { events } : {})).rejects.toThrow(message);
  });

  it('meters emit statements, within their static bound', async () => {
    const source = 'request R {\n  emit com.example.Greeted(who: "a" + "b", times: 1)\n}';
    const meter = new TokenMeter();
    await interpret(source, { events: resolver, meter });
    expect(meter.tokens).toBeGreaterThan(0);
    expect(meter.tokens).toBe(maxTokens(parseScript(source)));
  });

  it('refuses to run an event declaration', async () => {
    await expect(interpret('event a.E(x: string)')).rejects.toThrow('does not run');
  });
});

describe('events: consuming', () => {
  const consumer = 'contract c.OnGreeted consumes com.example.Greeted {\n  fn on(who: string, times: int64) {\n    emit com.example.Greeted(who: "${who}!", times: times + 1)\n  }\n}';

  it("binds the event's fields as the handler's parameters", async () => {
    const result = await interpret(consumer, { events: resolver, parameters: { who: 'Ada', times: '41' } });
    expect(result.returnValue).toBeNull();
    expect(result.events).toEqual([{ path: 'com.example', name: 'Greeted', version: '2', data: { who: 'Ada!', times: 42 } }]);
  });

  it('checks the event data against the fields', async () => {
    await expect(interpret(consumer, { events: resolver, parameters: { who: 'Ada' } })).rejects.toThrow(ParameterError);
    await expect(interpret(consumer, { events: resolver, parameters: { who: 'Ada', times: 1, other: 2 } })).rejects.toThrow("Unknown parameter 'other'");
  });

  it('lets the handler take only the fields it reads', async () => {
    const source = 'contract c.OnGreeted consumes com.example.Greeted {\n  var state(who) seen: int32 = 0\n  fn on(who: string) {\n    seen = seen + 1\n  }\n}';
    await expect(interpret(source, { events: resolver, parameters: { who: 'Ada', times: 1 }, state: { get: async () => undefined } }))
      .rejects.toThrow("Unknown variable 'who'");
    const inHandler = 'contract c.OnGreeted consumes com.example.Greeted {\n  fn on(who: string) {\n    var state(who) seen: int32 = 0\n    seen = seen + 1\n  }\n}';
    const result = await interpret(inHandler, { events: resolver, parameters: { who: 'Ada', times: 1 }, state: { get: async () => undefined } });
    expect(result.function).toBe('on');
    expect(result.state).toEqual([{ name: 'seen', scope: { kind: 'string', key: 'Ada' }, value: 1, type: '{"kind":"int32"}' }]);
  });

  it("refuses a handler parameter that isn't a field of the event, or has another type", async () => {
    const parameters = { who: 'Ada', times: 1 };
    await expect(interpret('contract c.On consumes com.example.Greeted {\n  fn on(whom: string) { }\n}', { events: resolver, parameters }))
      .rejects.toThrow("has no field 'whom' for the handler to take");
    await expect(interpret('contract c.On consumes com.example.Greeted {\n  fn on(times: int32) { }\n}', { events: resolver, parameters }))
      .rejects.toThrow("takes field 'times' as int32, but event 'com.example.Greeted' declares it int64");
  });

  it('runs only its handler', async () => {
    await expect(interpret(consumer, { function: 'other', events: resolver, parameters: { who: 'Ada', times: 1 } }))
      .rejects.toThrow("runs only its handler, 'on'");
  });

  it('needs the consumed event from the host', async () => {
    await expect(interpret(consumer, { parameters: { who: 'Ada', times: 1 } })).rejects.toThrow('needs a host that publishes events');
  });

  it('refuses a field named like a built-in', async () => {
    await expect(interpret(consumer, { events: resolver, parameters: { who: 'Ada', times: 1 }, builtins: { who: 'x' } }))
      .rejects.toThrow('conflicts with a built-in');
  });
});
