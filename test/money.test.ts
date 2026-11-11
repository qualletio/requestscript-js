import { describe, expect, it } from 'vitest';
import { ParseError, RuntimeError, ScriptFailure } from '../src/lang/errors.js';
import { type CallAttachment, createResourceResolver, interpret, MAX_PAYEES, type ResourceInvoker } from '../src/lang/interpreter.js';
import { maxTokens, TokenMeter } from '../src/lang/meter.js';
import { parseScript } from '../src/lang/parser.js';
import type { Resource } from '../src/lang/resource.js';

/** A contract version, as a host serves one: versioned, with one function, `run`. */
const job: Resource = {
  path: 'com.example',
  name: 'Job',
  version: '1',
  metadata: {},
  functions: [{ name: 'run', parameters: [{ name: 'action', type: 'string' }], returnType: 'string', exec: async () => 'ok' }],
};

/** Runs `source` against the Job contract, recording what each call attached. */
async function attaching(source: string, options: Parameters<typeof interpret>[1] = {}) {
  const calls: { functionName: string, attachment: CallAttachment | undefined, arity: number }[] = [];
  const resourceInvoker: ResourceInvoker = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async invoke(_resource, functionName, _parameters, attachment) {
      // eslint-disable-next-line prefer-rest-params
      calls.push({ functionName, attachment, arity: arguments.length });
      return { value: 'ok', error: null };
    },
  };
  const result = await interpret(source, { resourceResolver: createResourceResolver([job]), resourceInvoker, ...options });
  return { result, calls };
}

describe('payable contracts', () => {
  it('parses payable before contract, without making payable a keyword', () => {
    const script = parseScript('payable contract com.example.Tip(note: string): int64 {\n  return payment.amount\n}');
    expect(script.declaration).toMatchObject({ kind: 'contract', name: 'Tip', payable: true });
    expect(parseScript('contract com.example.Tip: int32 {\n  return 1\n}').declaration).not.toHaveProperty('payable');
    expect(parseScript('request R {\n  var payable = 1\n  return payable\n}').body).toHaveLength(2);
  });

  it('refuses a payable event contract', () => {
    expect(() => parseScript('payable contract com.example.OnPaid consumes com.example.Paid {\n}')).toThrow(ParseError);
  });

  it('reads the attached money as payment, which is never null', async () => {
    const tip = 'payable contract com.example.Tip: object {\n  return { amount: payment.amount, from: payment.from, payees: payment.payees }\n}';
    expect((await interpret(tip, { payment: { amount: 2_500_000, from: 'org_buyer', payees: ['org_courier'] } })).returnValue)
      .toEqual({ amount: 2_500_000, from: 'org_buyer', payees: ['org_courier'] });
    expect((await interpret(tip)).returnValue).toEqual({ amount: 0, from: null, payees: [] });
  });

  it('keeps payment.amount an int64, so arithmetic on it is checked', async () => {
    const half = 'payable contract com.example.Half: int64 {\n  return payment.amount * 70 / 100\n}';
    expect((await interpret(half, { payment: { amount: 1_000_001, from: 'org_buyer', payees: ['org_a'] } })).returnValue).toBe(700_000);
    const huge = 'payable contract com.example.Huge: int64 {\n  return payment.amount * 9223372036854775807\n}';
    await expect(interpret(huge, { payment: { amount: 2, from: 'org_buyer', payees: ['org_a'] } })).rejects.toThrow('int64 overflow');
  });

  it('can\'t redeclare payment', async () => {
    await expect(interpret('payable contract com.example.Tip: int32 {\n  var payment = 1\n  return payment\n}')).rejects.toThrow('built-in');
  });

  it('refuses money attached to a contract that isn\'t payable, and invalid amounts', async () => {
    const plain = 'contract com.example.Plain: int64 {\n  return payment.amount\n}';
    await expect(interpret(plain, { payment: { amount: 1, from: 'org_buyer', payees: ['org_a'] } })).rejects.toThrow("com.example.Plain isn't payable");
    // A host may pass nothing attached, which such a contract reads as 0.
    expect((await interpret(plain, { payment: { amount: 0, from: null, payees: [] } })).returnValue).toBe(0);
    // Without one, a contract that isn't payable has no payment, so existing contracts may use the name.
    expect((await interpret('contract com.example.Old: int32 {\n  var payment = 3\n  return payment\n}')).returnValue).toBe(3);
    for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(interpret('payable contract com.example.Tip: int32 {\n  return 1\n}', { payment: { amount, from: 'org_b', payees: ['org_a'] } })).rejects.toThrow(RuntimeError);
    }
  });
});

describe('call options', () => {
  it('attach money to a pinned call from a request script, with its payees', async () => {
    const { result, calls } = await attaching('request Hire {\n  const job: com.example.Job@1\n  return job.run{amount: 20000000, payees: ["org_courier"]}(action: "fund").value\n}');
    expect(result.returnValue).toBe('ok');
    expect(calls).toEqual([{ functionName: 'run', attachment: { amount: 20_000_000, payees: ['org_courier'] }, arity: 4 }]);
  });

  it('attach money from a contract\'s funding, with its key, narrowing payees', async () => {
    const market = [
      'contract com.example.Market(buyer: string): string {',
      '  const job: com.example.Job@1',
      '  return job.run{amount: 5, from: buyer, key: "order-1", payees: ["org_courier"]}(action: "fund").value',
      '}',
    ].join('\n');
    const { calls } = await attaching(market, { parameters: { buyer: 'org_buyer' } });
    expect(calls[0]!.attachment).toEqual({ amount: 5, payees: ['org_courier'], from: 'org_buyer', key: 'order-1' });
    const unearmarked = market.replace('key: "order-1", payees: ["org_courier"]', 'key: null');
    expect((await attaching(unearmarked, { parameters: { buyer: 'org_buyer' } })).calls[0]!.attachment).toEqual({ amount: 5, from: 'org_buyer', key: null });
  });

  it('attach nothing for an amount of 0, and call the host as before', async () => {
    const { calls } = await attaching('request Hire {\n  const job: com.example.Job@1\n  return job.run{amount: 0, payees: ["org_courier"]}(action: "fund").value\n}');
    expect(calls).toEqual([{ functionName: 'run', attachment: undefined, arity: 3 }]);
    expect((await attaching('request Plain {\n  const job: com.example.Job\n  return job.run(action: "x").value\n}')).calls[0]!.arity).toBe(3);
  });

  it('need a pinned version to attach money, even in a request script', async () => {
    await expect(attaching('request Hire {\n  const job: com.example.Job\n  return job.run{amount: 1, payees: ["org_courier"]}(action: "fund")\n}'))
      .rejects.toThrow("bind it as 'com.example.Job@<version>'");
  });

  it('refuse amounts that are negative, fractional or too large, and bad payees, before the call', async () => {
    const hire = (options: string) => attaching(`request Hire {\n  const job: com.example.Job@1\n  return job.run{${options}}(action: "fund")\n}`);
    for (const options of [
      'amount: -1, payees: ["a"]',
      'amount: 1.5, payees: ["a"]',
      `amount: ${Number.MAX_SAFE_INTEGER + 1}, payees: ["a"]`,
      'amount: "5", payees: ["a"]',
      'amount: 1, payees: []',
      'amount: 1, payees: ["a", "a"]',
      'amount: 1, payees: [""]',
      'amount: 1, payees: "a"',
      `amount: 1, payees: [${Array.from({ length: MAX_PAYEES + 1 }, (_, i) => `"org_${i}"`).join(', ')}]`,
    ]) {
      const { calls } = await hire(options).then(() => ({ calls: ['ran'] }), (error: unknown) => {
        expect(error).toBeInstanceOf(RuntimeError);
        return { calls: [] };
      });
      expect(calls, options).toEqual([]);
    }
  });

  it('are checked when parsed', () => {
    const request = (options: string) => () => parseScript(`request R {\n  const job: com.example.Job@1\n  return job.run{${options}}(action: "x")\n}`);
    const contract = (options: string) => () => parseScript(`contract com.example.C: string {\n  const job: com.example.Job@1\n  return job.run{${options}}(action: "x").value\n}`);
    expect(request('amount: 1, payees: ["a"]')).not.toThrow();
    expect(request('payees: ["a"]')).toThrow('need an amount');
    expect(request('amount: 1')).toThrow('payees');
    expect(request('amount: 1, payees: ["a"], from: "b"')).toThrow('no from or key');
    expect(request('amount: 1, payees: ["a"], tip: 2')).toThrow("Unknown call option 'tip'");
    expect(request('amount: 1, amount: 2, payees: ["a"]')).toThrow("Duplicate call option 'amount'");
    expect(contract('amount: 1')).toThrow('with from');
    expect(contract('amount: 1, from: "b"')).not.toThrow();
    expect(() => parseScript('request R {\n  const job: com.example.Job@1\n  return job.run{amount: 1, payees: ["a"]}\n}')).toThrow('followed by the call');
  });

  it('are metered, and counted in the most tokens a script can execute', async () => {
    const source = 'request Hire {\n  const job: com.example.Job@1\n  return job.run{amount: 20000000, payees: ["org_courier"]}(action: "fund").value\n}';
    const plain = 'request Hire {\n  const job: com.example.Job@1\n  return job.run(action: "fund").value\n}';
    const meter = new TokenMeter();
    await attaching(source, { meter });
    expect(meter.tokens).toBe(maxTokens(parseScript(source)));
    // `{`, `amount`, `:`, the amount, `,`, `payees`, `:`, `[`, the payee, `]`, `}`.
    expect(maxTokens(parseScript(source)) - maxTokens(parseScript(plain))).toBe(11);
  });

  it('don\'t turn a block or an object on its own line into options', () => {
    expect(() => parseScript('request R {\n  const job: com.example.Job@1\n  if (job.run(action: "x").value == "ok") {\n    return 1\n  }\n  return 2\n}')).not.toThrow();
    expect(() => parseScript('request R {\n  var o = { a: 1 }\n  var b = o.a\n  return b\n}')).not.toThrow();
  });
});

describe('now', () => {
  it('is the host\'s time as int64 milliseconds, and isn\'t declared without one', async () => {
    const at = new Date('2026-11-11T12:00:00Z');
    expect((await interpret('request R {\n  return now + 1000\n}', { now: at })).returnValue).toBe(at.getTime() + 1000);
    expect((await interpret('request R {\n  return now\n}', { now: 5n })).returnValue).toBe(5);
    await expect(interpret('request R {\n  return now\n}')).rejects.toThrow(RuntimeError);
    expect((await interpret('request R {\n  var now = 2\n  return now\n}')).returnValue).toBe(2);
  });
});

describe('fail', () => {
  it('fails the run on purpose with the script\'s reason', async () => {
    const failing = interpret('payable contract com.example.Job(action: string): string {\n  if (payment.amount == 0) {\n    fail "fund needs money attached"\n  }\n  return action\n}', { parameters: { action: 'fund' } });
    await expect(failing).rejects.toBeInstanceOf(ScriptFailure);
    await expect(failing).rejects.toMatchObject({ reason: 'fund needs money attached', line: 3 });
  });

  it('takes any string expression, and refuses anything else', async () => {
    await expect(interpret('request R {\n  var why = "no"\n  fail "because ${why}"\n}')).rejects.toMatchObject({ reason: 'because no' });
    await expect(interpret('request R {\n  var why = "no"\n  fail why\n}')).rejects.toMatchObject({ reason: 'no' });
    await expect(interpret('request R {\n  fail (1)\n}')).rejects.toThrow('fail needs a string message, not int32');
  });

  it('isn\'t a keyword', async () => {
    expect((await interpret('request R {\n  var fail = 1\n  fail = fail + 1\n  return fail\n}')).returnValue).toBe(2);
  });

  it('runs no later statement, and is metered', async () => {
    const source = 'request R {\n  fail "stop"\n  return 1\n}';
    const meter = new TokenMeter();
    await expect(interpret(source, { meter })).rejects.toBeInstanceOf(ScriptFailure);
    // `fail` and its message.
    expect(meter.tokens).toBe(2);
  });
});

describe('determinism', () => {
  it('runs the same way twice with the same inputs', async () => {
    const source = [
      'payable contract com.example.Split(note: string): object {',
      '  const author = payment.amount * 70 / 100',
      '  var shares = { data: payment.amount - author, author: author }',
      '  var label = "${note}: ${author} at ${now}"',
      '  return { shares: shares, label: label, later: "b" < "a", ratio: 1.0 / 3 }',
      '}',
    ].join('\n');
    const options = { parameters: { note: 'Ünïcode' }, payment: { amount: 1_000_001, from: 'org_buyer', payees: ['org_author', 'org_data'] }, now: 1_700_000_000_000 };
    const first = await interpret(source, options);
    const second = await interpret(source, options);
    expect(JSON.stringify(second.returnValue)).toBe(JSON.stringify(first.returnValue));
    expect(first.returnValue).toEqual({
      shares: { data: 300_001, author: 700_000 },
      label: 'Ünïcode: 700000 at 1700000000000',
      later: false,
      ratio: 0.3333333333,
    });
  });
});
