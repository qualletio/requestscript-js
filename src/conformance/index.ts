/**
 * The deterministic conformance suite: scripts with fixed inputs and the exact outputs every release of the
 * interpreter must produce. A host that replays runs (such as Stellarium's operator, verifying payable
 * contracts) runs it against an interpreter version before trusting the version to replay what another
 * version ran. `npm publish` runs it too, so no release that fails it is published.
 */
import { Decimal } from '../lang/decimal.js';
import { RequestScriptError } from '../lang/errors.js';
import {
  type CallAttachment,
  createResourceResolver,
  type EmittedEvent,
  type EventType,
  interpretParsed,
  type InterpretResult,
  type ResourceInvoker,
  type StateScope,
  type StateWrite,
  type StoredState,
} from '../lang/interpreter.js';
import { TokenMeter } from '../lang/meter.js';
import { parseScript } from '../lang/parser.js';
import type { Resource, ResourceFunctionCallParameter } from '../lang/resource.js';
import { createStructResolver, type StructType } from '../lang/structs.js';
import { CONFORMANCE_CASES } from './cases.js';

export { CONFORMANCE_CASES } from './cases.js';

/** A resource a case's script may bind. It has no implementation: its calls get the case's `responses`. */
export interface ConformanceResource {
  path: string;
  name: string;
  version?: string;
  functions: { name: string; parameters: { name: string; type: string }[]; returnType: string }[];
}

/** One resource call as the host received it. Values are host values in `canonicalJson`'s form. */
export interface ConformanceCall {
  resource: string;
  function: string;
  parameters: ResourceFunctionCallParameter[];
  attachment?: CallAttachment;
}

export interface ConformanceCase {
  name: string;
  source: string;
  parameters?: Record<string, unknown>;
  builtins?: Record<string, unknown>;
  payment?: { amount: number; from: string | null; payees: string[] };
  now?: number;
  resources?: ConformanceResource[];
  /** What each resource call returns, in the order the script makes them, as a recorded transcript does. */
  responses?: ({ value: unknown } | { error: string })[];
  /** Stored state variables, by name and scope. */
  state?: { name: string; scope: StateScope; stored: StoredState }[];
  events?: EventType[];
  structs?: StructType[];
  expect: {
    /** The return value exactly as `JSON.stringify` writes it, so key order counts. Omitted when the run fails. */
    returnValue?: string;
    /** The error the run fails with: its class name and full message. */
    error?: { type: string; message: string };
    tokens: number;
    /** Omitted: the script calls nothing. */
    calls?: ConformanceCall[];
    /** Omitted: no writes. Ignored when the run fails. */
    state?: StateWrite[];
    /** Omitted: no events. Ignored when the run fails. */
    events?: EmittedEvent[];
  };
}

/** What a case produced, in the form its expectations are written in. */
export interface ConformanceOutcome {
  returnValue?: string;
  error?: { type: string; message: string };
  tokens: number;
  calls: ConformanceCall[];
  state: StateWrite[];
  events: EmittedEvent[];
}

export interface ConformanceFailure {
  name: string;
  /** Which output differed, with what was expected and what the interpreter produced. */
  differences: { output: string; expected: string; actual: string }[];
}

/** JSON with every host value written exactly: an int64 as `{ "$int64": "..." }`, a decimal as `{ "$decimal": "..." }`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, function (key, raw: unknown) {
    // `this[key]` is the value before its `toJSON`, which a Decimal has.
    const original = (this as Record<string, unknown>)[key];
    if (typeof original === 'bigint') return { $int64: original.toString() };
    if (original instanceof Decimal) return { $decimal: original.toString() };
    return raw;
  }) ?? 'undefined';
}

/** Runs one case: its script, with its inputs, recording what it calls and produces. */
export async function runConformanceCase(testCase: ConformanceCase): Promise<ConformanceOutcome> {
  const calls: ConformanceCall[] = [];
  const responses = [...(testCase.responses ?? [])];
  const resources: Resource[] = (testCase.resources ?? []).map((resource) => ({
    path: resource.path,
    name: resource.name,
    ...(resource.version === undefined ? {} : { version: resource.version }),
    metadata: {},
    functions: resource.functions.map((fn) => ({ ...fn, exec: async () => { throw new Error('Conformance resources answer from responses'); } })),
  }));
  const resourceInvoker: ResourceInvoker = {
    async invoke(resource, functionName, parameters, attachment) {
      calls.push({
        resource: resource.version === undefined ? `${resource.path}.${resource.name}` : `${resource.path}.${resource.name}@${resource.version}`,
        function: functionName,
        // Host values go through JSON so a case records them as written.
        parameters: JSON.parse(canonicalJson(parameters)) as ResourceFunctionCallParameter[],
        ...(attachment === undefined ? {} : { attachment }),
      });
      const response = responses.shift();
      if (response === undefined) throw new Error(`The case has no response for call ${calls.length}`);
      return 'error' in response ? { value: null, error: { message: response.error } } : { value: response.value, error: null };
    },
  };
  const stored = new Map((testCase.state ?? []).map((entry) => [JSON.stringify([entry.name, entry.scope]), entry.stored]));
  const eventTypes = testCase.events ?? [];
  const meter = new TokenMeter();
  let result: InterpretResult | undefined;
  let error: { type: string; message: string } | undefined;
  try {
    result = await interpretParsed(parseScript(testCase.source), {
      resourceResolver: createResourceResolver(resources),
      resourceInvoker,
      meter,
      ...(testCase.parameters === undefined ? {} : { parameters: testCase.parameters }),
      ...(testCase.builtins === undefined ? {} : { builtins: testCase.builtins }),
      ...(testCase.payment === undefined ? {} : { payment: testCase.payment }),
      ...(testCase.now === undefined ? {} : { now: testCase.now }),
      state: { get: async (name, scope) => stored.get(JSON.stringify([name, scope])) },
      events: {
        resolve: async (path, name, version) => eventTypes.find((type) => type.path === path && type.name === name && (version === undefined || type.version === version)),
      },
      structs: createStructResolver(testCase.structs ?? []),
    });
  } catch (thrown) {
    // Only the language's own errors are outcomes; anything else is a bug in the interpreter or the case.
    if (!(thrown instanceof RequestScriptError)) throw thrown;
    error = { type: thrown.name, message: thrown.message };
  }
  return {
    ...(result ? { returnValue: canonicalJson(result.returnValue) } : {}),
    ...(error ? { error } : {}),
    tokens: meter.tokens,
    calls,
    state: result?.state ?? [],
    events: result?.events ?? [],
  };
}

/** Where a case's outcome differs from what it expects. Empty when it conforms. */
export function conformanceDifferences(testCase: ConformanceCase, outcome: ConformanceOutcome): ConformanceFailure['differences'] {
  const { expect } = testCase;
  const differences: ConformanceFailure['differences'] = [];
  const compare = (output: string, expected: unknown, actual: unknown) => {
    const [e, a] = [canonicalJson(expected), canonicalJson(actual)];
    if (e !== a) differences.push({ output, expected: e, actual: a });
  };
  compare('returnValue', expect.returnValue, outcome.returnValue);
  compare('error', expect.error, outcome.error);
  compare('tokens', expect.tokens, outcome.tokens);
  compare('calls', expect.calls ?? [], outcome.calls);
  if (!outcome.error) {
    compare('state', expect.state ?? [], outcome.state);
    compare('events', expect.events ?? [], outcome.events);
  }
  return differences;
}

/** Runs every case. The interpreter conforms when `failures` is empty. */
export async function runConformance(cases: readonly ConformanceCase[] = CONFORMANCE_CASES): Promise<{ passed: number; failures: ConformanceFailure[] }> {
  const failures: ConformanceFailure[] = [];
  for (const testCase of cases) {
    const differences = conformanceDifferences(testCase, await runConformanceCase(testCase));
    if (differences.length > 0) failures.push({ name: testCase.name, differences });
  }
  return { passed: cases.length - failures.length, failures };
}
