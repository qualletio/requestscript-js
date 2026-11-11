import { describe, expect, it } from 'vitest';
import { CONFORMANCE_CASES, type ConformanceCase, runConformance } from '../src/conformance/index.js';

describe('the deterministic conformance suite', () => {
  it('passes every case', async () => {
    const { passed, failures } = await runConformance();
    expect(failures).toEqual([]);
    expect(passed).toBe(CONFORMANCE_CASES.length);
  });

  it('has unique case names, so a failure names one case', () => {
    expect(new Set(CONFORMANCE_CASES.map((testCase) => testCase.name)).size).toBe(CONFORMANCE_CASES.length);
  });

  it('reports any output that differs, down to key order and tokens', async () => {
    const base = CONFORMANCE_CASES.find((testCase) => testCase.name.startsWith('object keys keep the order'))!;
    const reordered: ConformanceCase = { ...base, expect: { ...base.expect, returnValue: '{"alpha":2,"zeta":4,"mid":3}', tokens: base.expect.tokens + 1 } };
    const { failures } = await runConformance([reordered]);
    expect(failures).toEqual([{
      name: base.name,
      differences: [
        { output: 'returnValue', expected: '"{\\"alpha\\":2,\\"zeta\\":4,\\"mid\\":3}"', actual: '"{\\"zeta\\":4,\\"alpha\\":2,\\"mid\\":3}"' },
        { output: 'tokens', expected: String(base.expect.tokens + 1), actual: String(base.expect.tokens) },
      ],
    }]);
  });

  it('reports a call made with other arguments or other money', async () => {
    const base = CONFORMANCE_CASES.find((testCase) => testCase.name.startsWith('a request script attaches money'))!;
    const calls = base.expect.calls!.map((call) => ({ ...call, attachment: { amount: 1, payees: ['org_courier'] } }));
    const { failures } = await runConformance([{ ...base, expect: { ...base.expect, calls } }]);
    expect(failures.map((failure) => failure.differences.map((difference) => difference.output))).toEqual([['calls']]);
  });
});
