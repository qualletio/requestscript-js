import { describe, expect, it } from 'vitest';
import { ParseError, RuntimeError, ScriptFailure } from '../src/lang/errors.js';
import { type CallAttachment, createResourceResolver, interpret, MAX_PAYEES, type ResourceInvoker } from '../src/lang/interpreter.js';
import { maxTokens, TokenMeter } from '../src/lang/meter.js';
import { parseScript } from '../src/lang/parser.js';
import type { Resource } from '../src/lang/resource.js';

/** A contract version, as a host serves one: versioned, with one entrypoint, `run`. */
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

/** A contract with one entrypoint, `run`, written `pub payable fn` when `payable`. */
const contract = (name: string, signature: string, body: string, payable = true) =>
  `contract com.example.${name} {\n  pub ${payable ? 'payable ' : ''}fn run${signature} {\n${body}\n  }\n}`;

describe('payable functions', () => {
  it('parses pub payable fn, without making payable a keyword', () => {
    const script = parseScript(contract('Tip', '(note: string): int64', 'return payment.amount'));
    expect(script.functions[0]).toMatchObject({ name: 'run', pub: true, payable: true });
    expect(parseScript(contract('Tip', '(): int32', 'return 1', false)).functions[0]!.payable).toBe(false);
    expect(parseScript('request R {\n  var payable = 1\n  return payable\n}').body).toHaveLength(2);
  });

  it('refuses a payable event handler', () => {
    expect(() => parseScript('contract com.example.OnPaid consumes com.example.Paid {\n  pub payable fn on() { }\n}')).toThrow(ParseError);
  });

  it('reads the attached money as payment, which is never null', async () => {
    const tip = contract('Tip', '(): object', 'return { amount: payment.amount, from: payment.from, payees: payment.payees }');
    expect((await interpret(tip, { function: 'run', payment: { amount: 2_500_000, from: 'org_buyer', payees: ['org_courier'] } })).returnValue)
      .toEqual({ amount: 2_500_000, from: 'org_buyer', payees: ['org_courier'] });
    expect((await interpret(tip, { function: 'run' })).returnValue).toEqual({ amount: 0, from: null, payees: [] });
  });

  it('lets the payable entrypoint\'s helpers read payment too', async () => {
    const source = 'contract com.example.Tip {\n  fn amount(): int64 {\n    return payment.amount\n  }\n  pub payable fn run(): int64 {\n    return amount()\n  }\n}';
    expect((await interpret(source, { function: 'run', payment: { amount: 7, from: 'org_b', payees: ['org_a'] } })).returnValue).toBe(7);
  });

  it('keeps payment.amount an int64, so arithmetic on it is checked', async () => {
    const half = contract('Half', '(): int64', 'return payment.amount * 70 / 100');
    expect((await interpret(half, { function: 'run', payment: { amount: 1_000_001, from: 'org_buyer', payees: ['org_a'] } })).returnValue).toBe(700_000);
    const huge = contract('Huge', '(): int64', 'return payment.amount * 9223372036854775807');
    await expect(interpret(huge, { function: 'run', payment: { amount: 2, from: 'org_buyer', payees: ['org_a'] } })).rejects.toThrow('int64 overflow');
  });

  it('can\'t redeclare payment', async () => {
    await expect(interpret(contract('Tip', '(): int32', 'var payment = 1\nreturn payment'), { function: 'run' })).rejects.toThrow('built-in');
  });

  it('refuses money attached to a function that isn\'t payable, and invalid amounts', async () => {
    const plain = contract('Plain', '(): int64', 'return payment.amount', false);
    await expect(interpret(plain, { function: 'run', payment: { amount: 1, from: 'org_buyer', payees: ['org_a'] } }))
      .rejects.toThrow("Function 'run' of contract 'com.example.Plain' isn't payable");
    // A host may pass nothing attached, which such a function reads as 0.
    expect((await interpret(plain, { function: 'run', payment: { amount: 0, from: null, payees: [] } })).returnValue).toBe(0);
    // Without one, a function that isn't payable has no payment, so it may use the name.
    expect((await interpret(contract('Old', '(): int32', 'var payment = 3\nreturn payment', false), { function: 'run' })).returnValue).toBe(3);
    for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(interpret(contract('Tip', '(): int32', 'return 1'), { function: 'run', payment: { amount, from: 'org_b', payees: ['org_a'] } })).rejects.toThrow(RuntimeError);
    }
  });

  it('marks each entrypoint payable or not on its own', async () => {
    const shop = 'contract com.example.Shop {\n  pub payable fn buy(): int64 {\n    return payment.amount\n  }\n  pub fn price(): int64 {\n    return 5\n  }\n}';
    const payment = { amount: 5, from: 'org_buyer', payees: ['org_shop'] };
    expect((await interpret(shop, { function: 'buy', payment })).returnValue).toBe(5);
    await expect(interpret(shop, { function: 'price', payment })).rejects.toThrow("Function 'price' of contract 'com.example.Shop' isn't payable");
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
      'contract com.example.Market {',
      '  const job: com.example.Job@1',
      '  pub fn buy(buyer: string): string {',
      '    return job.run{amount: 5, from: buyer, key: "order-1", payees: ["org_courier"]}(action: "fund").value',
      '  }',
      '}',
    ].join('\n');
    const { calls } = await attaching(market, { function: 'buy', parameters: { buyer: 'org_buyer' } });
    expect(calls[0]!.attachment).toEqual({ amount: 5, payees: ['org_courier'], from: 'org_buyer', key: 'order-1' });
    const unearmarked = market.replace('key: "order-1", payees: ["org_courier"]', 'key: null');
    expect((await attaching(unearmarked, { function: 'buy', parameters: { buyer: 'org_buyer' } })).calls[0]!.attachment).toEqual({ amount: 5, from: 'org_buyer', key: null });
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
    const contract = (options: string) => () => parseScript(`contract com.example.C {\n  const job: com.example.Job@1\n  pub fn run(): string {\n    return job.run{${options}}(action: "x").value\n  }\n}`);
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
    const failing = interpret(contract('Job', '(action: string): string', 'if (payment.amount == 0) {\n  fail "fund needs money attached"\n}\nreturn action'), { function: 'run', parameters: { action: 'fund' } });
    await expect(failing).rejects.toBeInstanceOf(ScriptFailure);
    await expect(failing).rejects.toMatchObject({ reason: 'fund needs money attached', line: 4 });
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
      'contract com.example.Split {',
      '  pub payable fn split(note: string): object {',
      '    const author = payment.amount * 70 / 100',
      '    var shares = { data: payment.amount - author, author: author }',
      '    var label = "${note}: ${author} at ${now}"',
      '    return { shares: shares, label: label, later: "b" < "a", ratio: 1.0 / 3 }',
      '  }',
      '}',
    ].join('\n');
    const options = { function: 'split', parameters: { note: 'Ünïcode' }, payment: { amount: 1_000_001, from: 'org_buyer', payees: ['org_author', 'org_data'] }, now: 1_700_000_000_000 };
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
