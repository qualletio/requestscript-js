import { describe, expect, it } from 'vitest';
import { ParameterError } from '../src/lang/errors.js';
import { run } from './helpers.js';

describe('interpreter: contract parameters', () => {
  const greet = 'contract path.to.Greet(name: string) { return "Hello ${name}!" }';

  it('binds parameters into the script', async () => {
    expect(await run(greet, { parameters: { name: 'World' } })).toBe('Hello World!');
  });

  it('rejects missing and unknown parameters', async () => {
    await expect(run(greet, {})).rejects.toThrow(/Missing parameter 'name'/);
    await expect(run(greet, { parameters: {} })).rejects.toThrow(/Missing parameter 'name'/);
    await expect(run(greet, { parameters: { name: 'x', extra: 1 } })).rejects.toThrow(/Unknown parameter 'extra'/);
  });

  it('rejects badly typed parameters with ParameterError', async () => {
    await expect(run(greet, { parameters: { name: 5 } })).rejects.toThrow(ParameterError);
  });

  it('parameters are constants', async () => {
    const script = 'contract C(x: int32) { x = 2\nreturn x }';
    await expect(run(script, { parameters: { x: 1 } })).rejects.toThrow(/const/);
  });

  it('validates and converts numeric parameters', async () => {
    const sum = 'contract C(a: int32, b: int64) { return a + b }';
    expect(await run(sum, { parameters: { a: 1, b: 2 } })).toBe(3);
    // int64 can be passed as a string to preserve precision
    expect(await run(sum, { parameters: { a: 1, b: '9223372036854775806' } })).toBe('9223372036854775807');
    await expect(run(sum, { parameters: { a: 1.5, b: 2 } })).rejects.toThrow(ParameterError);
    await expect(run(sum, { parameters: { a: 3000000000, b: 2 } })).rejects.toThrow(/out of range for int32/);
  });

  it('validates decimal parameters including digit constraints', async () => {
    const script = 'contract C(price: decimal(4, 2)) { return price * 2 }';
    expect(await run(script, { parameters: { price: 12.25 } })).toBe(24.5);
    expect(await run(script, { parameters: { price: '0.05' } })).toBe(0.1);
    await expect(run(script, { parameters: { price: 12345.0 } })).rejects.toThrow(/digits before/);
    await expect(run(script, { parameters: { price: 1.005 } })).rejects.toThrow(/digits after/);
  });

  it('validates boolean, list, and object parameters', async () => {
    const script = 'contract C(flag: boolean, tags: []string, meta: object) {\n' +
      'if (flag) { return tags[0] }\nreturn meta.key\n}';
    expect(await run(script, { parameters: { flag: true, tags: ['a'], meta: { key: 'v' } } })).toBe('a');
    expect(await run(script, { parameters: { flag: false, tags: [], meta: { key: 'v' } } })).toBe('v');
    await expect(run(script, { parameters: { flag: 'yes', tags: [], meta: {} } })).rejects.toThrow(ParameterError);
    await expect(run(script, { parameters: { flag: true, tags: [1], meta: {} } })).rejects.toThrow(ParameterError);
    await expect(run(script, { parameters: { flag: true, tags: [], meta: [] } })).rejects.toThrow(ParameterError);
  });

  it('supports nested list parameter types', async () => {
    const script = 'contract C(grid: [][]int32) { return grid[1][0] }';
    expect(await run(script, { parameters: { grid: [[1], [2, 3]] } })).toBe(2);
  });

  it('allows null parameter values', async () => {
    const script = 'contract C(x: string) { return x == null }';
    expect(await run(script, { parameters: { x: null } })).toBe(true);
  });

  it('rejects parameters passed to a request script', async () => {
    await expect(run('request R { return 1 }', { parameters: { x: 1 } })).rejects.toThrow(
      /does not take parameters/,
    );
  });

  it('runs a parameterless contract without a parameters object', async () => {
    expect(await run('contract MyParameterlessContract { return "ok" }')).toBe('ok');
  });
});
