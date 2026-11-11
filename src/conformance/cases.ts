import type { ConformanceCase } from './index.js';

/** A request script with `body` as its body. */
const request = (body: string): string => `request Case {\n${body}\n}`;

const PAYER = 'org_payer';
const COURIER = 'org_courier';

/** A versioned contract another contract or script pays, with one function, `run`. */
const job = { path: 'com.example', name: 'Job', version: '1', functions: [{ name: 'run', parameters: [{ name: 'action', type: 'string' }], returnType: 'string' }] };

/**
 * The cases every release must reproduce exactly. A case is only ever added to: changing what one expects
 * means scripts already deployed would run differently, which a replay would report as fraud.
 */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  // ---------- Integers ----------
  {
    name: 'int32 arithmetic that overflows fails rather than wrapping',
    source: request('const a = 2147483647\nreturn a + 1'),
    expect: { error: { type: 'RuntimeError', message: 'int32 overflow: 2147483648 (line 3)' }, tokens: 8 },
  },
  {
    name: 'int64 arithmetic that overflows fails rather than wrapping',
    source: request('const a = 9223372036854775807\nreturn a + 1'),
    expect: { error: { type: 'RuntimeError', message: 'int64 overflow: 9223372036854775808 (line 3)' }, tokens: 8 },
  },
  {
    name: 'int64 multiplication that overflows fails',
    source: request('const a = 4611686018427387904\nreturn a * 2'),
    expect: { error: { type: 'RuntimeError', message: 'int64 overflow: 9223372036854775808 (line 3)' }, tokens: 8 },
  },
  {
    name: 'int32 and int64 together are int64',
    source: request('const big = 3000000000\nconst small = 7\nreturn big + small'),
    expect: { returnValue: '3000000007', tokens: 12 },
  },
  {
    name: 'integer division truncates toward zero, for either sign',
    source: request('return [7 / 2, -7 / 2, 7 / -2, -7 / -2, 1 / 3]'),
    expect: { returnValue: '[3,-3,-3,3,0]', tokens: 26 },
  },
  {
    name: 'integer division by zero fails',
    source: request('const zero = 0\nreturn 5 / zero'),
    expect: { error: { type: 'RuntimeError', message: 'Division by zero (line 3)' }, tokens: 8 },
  },
  {
    name: 'an int64 outside the safe range is returned as a string, and one inside it as a number',
    source: request('return [9007199254740991, 9007199254740993, -9007199254740993]'),
    expect: { returnValue: '[9007199254740991,"9007199254740993","-9007199254740993"]', tokens: 9 },
  },
  {
    name: 'integers format without separators or exponents',
    source: request('return "${1000000} ${-42} ${9223372036854775807}"'),
    expect: { returnValue: '"1000000 -42 9223372036854775807"', tokens: 6 },
  },

  // ---------- Decimals ----------
  {
    name: 'decimal addition is exact',
    source: request('return 0.1 + 0.2'),
    expect: { returnValue: '0.3', tokens: 4 },
  },
  {
    name: 'decimal division keeps at least ten places, rounded half away from zero, without trailing zeros',
    source: request('return [1.0 / 3, 2.0 / 3, -2.0 / 3, 1.0 / 8, 3.00 / 1.5]'),
    expect: { returnValue: '[0.3333333333,0.6666666667,-0.6666666667,0.125,2]', tokens: 23 },
  },
  {
    name: 'decimal division rounds a half at the last place away from zero',
    source: request('return ["${0.0000000001 / 2}", "${-0.0000000001 / 2}", "${0.0000000003 / 2}"]'),
    expect: { returnValue: '["0.0000000001","-0.0000000001","0.0000000002"]', tokens: 18 },
  },
  {
    name: 'decimal multiplication is exact, without trailing zeros',
    source: request('return "${2.50 * 1.5} ${0.1 * 0.1} ${2.5 * 4}"'),
    expect: { returnValue: '"3.75 0.01 10"', tokens: 11 },
  },
  {
    name: 'an integer and a decimal together are a decimal',
    source: request('return 3 + 0.25'),
    expect: { returnValue: '3.25', tokens: 4 },
  },
  {
    name: 'decimal division by zero fails',
    source: request('const zero = 0.0\nreturn 1.5 / zero'),
    expect: { error: { type: 'RuntimeError', message: 'Division by zero (line 3)' }, tokens: 8 },
  },
  {
    name: 'decimal literals, sums and differences keep their scale in strings',
    source: request('return "${1.50} ${0.000} ${-3.10} ${1.50 + 1.25} ${2.00 - 0.5}"'),
    expect: { returnValue: '"1.50 0.000 -3.10 2.75 1.50"', tokens: 12 },
  },

  // ---------- Strings ----------
  {
    name: 'strings compare by UTF-16 code units, without a locale',
    source: request('return ["Z" < "a", "a" < "é", "é" < "z", "😀" < "ｚ", "abc" < "abd", "ab" < "abc"]'),
    expect: { returnValue: '[true,true,false,true,true,true]', tokens: 26 },
  },
  {
    name: 'strings are equal only when every code unit is',
    source: request('return ["é" == "é", "ﬀ" == "ff", "A" == "a"]'),
    expect: { returnValue: '[true,false,false]', tokens: 14 },
  },
  {
    name: 'concatenation formats each side',
    source: request('return "n=" + 5 + ", d=" + 1.20 + ", b=" + true + ", null=" + null'),
    expect: { returnValue: '"n=5, d=1.20, b=true, null=null"', tokens: 16 },
  },

  // ---------- Objects and lists ----------
  {
    name: 'object keys keep the order they were first set in',
    source: request('var o = { zeta: 1, alpha: 2 }\no.mid = 3\no.zeta = 4\nreturn o'),
    expect: { returnValue: '{"zeta":4,"alpha":2,"mid":3}', tokens: 24 },
  },
  {
    name: 'objects compare by their entries, whatever their order; lists by position',
    source: request('return [{ a: 1, b: 2 } == { b: 2, a: 1 }, [1, 2] == [2, 1], [1, 2] == [1, 2]]'),
    expect: { returnValue: '[true,false,true]', tokens: 46 },
  },
  {
    name: 'an index outside a list fails',
    source: request('const l = [1, 2]\nreturn l[2]'),
    expect: { error: { type: 'RuntimeError', message: 'List index 2 is out of bounds (list has 2 items) (line 3)' }, tokens: 13 },
  },
  {
    name: 'a missing object key reads as null',
    source: request('const o = { a: 1 }\nreturn o.b'),
    expect: { returnValue: 'null', tokens: 12 },
  },

  // ---------- Control flow and metering ----------
  {
    name: 'the costliest branch is never charged when another runs',
    source: request('const x = 2\nif (x == 1) {\n  return "one"\n} else if (x == 2) {\n  return "two"\n} else {\n  return "other"\n}'),
    expect: { returnValue: '"two"', tokens: 23 },
  },
  {
    name: '&& and || short-circuit, so the right side never runs',
    source: request('const o = { a: 1 }\nreturn [false && o.missing.deeper, true || o.missing.deeper]'),
    expect: { returnValue: '[false,true]', tokens: 16 },
  },
  {
    name: 'fail stops the run with its reason',
    source: request('const why = "no money"\nfail "refused: ${why}"\nreturn 1'),
    expect: { error: { type: 'ScriptFailure', message: 'refused: no money (line 3)' }, tokens: 7 },
  },

  // ---------- Built-ins ----------
  {
    name: 'now is the host\'s time, as int64 milliseconds',
    source: request('return [now, now + 86400000]'),
    now: 1_700_000_000_000,
    expect: { returnValue: '[1700000000000,1700086400000]', tokens: 8 },
  },
  {
    name: 'host built-ins convert like resource results',
    source: request('return [jwt.org, jwt.n, jwt.d]'),
    builtins: { jwt: { org: PAYER, n: 5, d: 1.5 } },
    expect: { returnValue: '["org_payer",5,1.5]', tokens: 14 },
  },

  // ---------- Money ----------
  {
    name: 'a payable contract reads the attached money, and splits it with truncating division',
    source: 'payable contract com.example.Split: object {\n  const author = payment.amount * 70 / 100\n  return { author: author, data: payment.amount - author, from: payment.from, payees: payment.payees }\n}',
    payment: { amount: 1_000_001, from: PAYER, payees: ['org_author', 'org_data'] },
    expect: { returnValue: '{"author":700000,"data":300001,"from":"org_payer","payees":["org_author","org_data"]}', tokens: 36 },
  },
  {
    name: 'a payable contract without money attached reads a payment of 0',
    source: 'payable contract com.example.Tip: object {\n  return payment\n}',
    expect: { returnValue: '{"amount":0,"from":null,"payees":[]}', tokens: 2 },
  },
  {
    name: 'a request script attaches money to a pinned call, and reads the recorded response',
    source: request('const job: com.example.Job@1\nconst result = job.run{amount: 20000000, payees: ["org_courier"]}(action: "fund")\nreturn result'),
    resources: [job],
    responses: [{ value: 'job-1' }],
    expect: {
      returnValue: '{"value":"job-1","error":null}',
      tokens: 34,
      calls: [{ resource: 'com.example.Job@1', function: 'run', parameters: [{ name: 'action', value: 'fund' }], attachment: { amount: 20_000_000, payees: [COURIER] } }],
    },
  },
  {
    name: 'a contract attaches money from a funder\'s funding under a key',
    source: 'contract com.example.Market(buyer: string): string {\n  const job: com.example.Job@1\n  return job.run{amount: 5, from: buyer, key: null}(action: "fund").value\n}',
    parameters: { buyer: PAYER },
    resources: [job],
    responses: [{ value: 'ok' }],
    expect: {
      returnValue: '"ok"',
      tokens: 34,
      calls: [{ resource: 'com.example.Job@1', function: 'run', parameters: [{ name: 'action', value: 'fund' }], attachment: { amount: 5, from: PAYER, key: null } }],
    },
  },
  {
    name: 'an amount of 0 attaches nothing',
    source: request('const job: com.example.Job@1\nreturn job.run{amount: 0, payees: ["org_courier"]}(action: "look").value'),
    resources: [job],
    responses: [{ value: 'ok' }],
    expect: { returnValue: '"ok"', tokens: 32, calls: [{ resource: 'com.example.Job@1', function: 'run', parameters: [{ name: 'action', value: 'look' }] }] },
  },
  {
    name: 'a negative amount fails before anything is called',
    source: request('const job: com.example.Job@1\nconst amount = 0 - 1\nreturn job.run{amount: amount, payees: ["org_courier"]}(action: "fund")'),
    resources: [job],
    expect: { error: { type: 'RuntimeError', message: 'The amount attached to a call must be whole micro-USD from 0 to 9007199254740991, not -1 (line 4)' }, tokens: 32 },
  },
  {
    name: 'a failed call reads as an error, which the script decides about',
    source: request('const job: com.example.Job@1\nconst result = job.run(action: "release")\nif (result.error != null) {\n  fail result.error.message\n}\nreturn result.value'),
    resources: [job],
    responses: [{ error: 'not allowed' }],
    expect: { error: { type: 'ScriptFailure', message: 'not allowed (line 5)' }, tokens: 37, calls: [{ resource: 'com.example.Job@1', function: 'run', parameters: [{ name: 'action', value: 'release' }] }] },
  },

  // ---------- Resources ----------
  {
    name: 'a recorded response converts to the function\'s return type',
    source: request('const ledger: com.example.Ledger\nreturn [ledger.total().value, ledger.rate().value]'),
    resources: [{ path: 'com.example', name: 'Ledger', functions: [{ name: 'total', parameters: [], returnType: 'int64' }, { name: 'rate', parameters: [], returnType: 'decimal' }] }],
    responses: [{ value: '9007199254740993' }, { value: '1.250' }],
    expect: {
      returnValue: '["9007199254740993",1.25]',
      tokens: 26,
      calls: [{ resource: 'com.example.Ledger', function: 'total', parameters: [] }, { resource: 'com.example.Ledger', function: 'rate', parameters: [] }],
    },
  },
  {
    name: 'arguments reach the host as exact values',
    source: request('const ledger: com.example.Ledger\nreturn ledger.add(amount: 9007199254740993, rate: 0.10).value'),
    resources: [{ path: 'com.example', name: 'Ledger', functions: [{ name: 'add', parameters: [{ name: 'amount', type: 'int64' }, { name: 'rate', type: 'decimal' }], returnType: 'boolean' }] }],
    responses: [{ value: true }],
    expect: {
      returnValue: 'true',
      tokens: 23,
      calls: [{ resource: 'com.example.Ledger', function: 'add', parameters: [{ name: 'amount', value: { $int64: '9007199254740993' } }, { name: 'rate', value: { $decimal: '0.10' } }] }],
    },
  },

  // ---------- Parameters ----------
  {
    name: 'contract parameters convert exactly from JSON',
    source: 'contract com.example.P(n: int64, d: decimal, s: string): object {\n  return { n: n + 1, d: d * 2, s: s }\n}',
    parameters: { n: '9007199254740993', d: '1.10', s: 'é' },
    expect: { returnValue: '{"n":"9007199254740994","d":2.2,"s":"é"}', tokens: 18 },
  },

  // ---------- State ----------
  {
    name: 'state is read from what was stored, and written with the version read',
    source: 'contract com.example.Counter(job: string): int64 {\n  var state count: int64 = 0\n  var state(job) paid: int64 = 0\n  count = count + 1\n  paid = paid + 5\n  return count\n}',
    parameters: { job: 'job-1' },
    state: [{ name: 'count', scope: null, stored: { value: 41, type: '{"kind":"int64"}', version: 7 } }],
    expect: {
      returnValue: '42',
      tokens: 28,
      state: [
        // Stored state keeps every kind exactly, so an int64 is encoded as one.
        { name: 'count', scope: null, value: { $int64: '42' }, type: '{"kind":"int64"}', version: 7 },
        { name: 'paid', scope: { kind: 'string', key: 'job-1' }, value: { $int64: '5' }, type: '{"kind":"int64"}' },
      ],
    },
  },

  // ---------- Events ----------
  {
    name: 'an emitted event records its data in field order',
    source: 'contract com.example.Deliver(job: string): string {\n  emit com.example.Delivered(job: job, at: 5)\n  return job\n}',
    parameters: { job: 'job-1' },
    events: [{ path: 'com.example', name: 'Delivered', version: '1', fields: [{ name: 'at', type: 'int64' }, { name: 'job', type: 'string' }] }],
    expect: { returnValue: '"job-1"', tokens: 17, events: [{ path: 'com.example', name: 'Delivered', version: '1', data: { at: 5, job: 'job-1' } }] },
  },

  // ---------- Structs ----------
  {
    name: 'a struct converts its declared fields, sets missing ones to null and keeps others',
    source: request('var a: com.example.Address@1 = { zip: "0150", street: "Main", extra: true }\nreturn a'),
    structs: [{ path: 'com.example', name: 'Address', version: '1', fields: [{ name: 'street', type: 'string' }, { name: 'zip', type: 'string' }, { name: 'city', type: 'string' }] }],
    expect: { returnValue: '{"zip":"0150","street":"Main","extra":true,"city":null}', tokens: 26 },
  },
];
