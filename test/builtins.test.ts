import { describe, expect, it } from 'vitest';
import { ParameterError, RuntimeError } from '../src/lang/errors.js';
import { createResourceResolver } from '../src/lang/interpreter.js';
import type { Resource } from '../src/lang/resource.js';
import { run, runBody } from './helpers.js';

const jwt = { sub: 'cli_1', exp: 1800000000, claims: { scope: 'read' }, aud: ['node-a', 'node-b'] };
const builtins = { jwt };

describe('interpreter: built-in variables', () => {
  it('reads built-ins and their fields', async () => {
    expect(await runBody('return jwt', { builtins })).toEqual(jwt);
    expect(await runBody('return jwt.sub', { builtins })).toBe('cli_1');
    expect(await runBody('return jwt.claims.scope', { builtins })).toBe('read');
    expect(await runBody('return jwt.aud[1]', { builtins })).toBe('node-b');
    expect(await runBody('return jwt.exp > 0', { builtins })).toBe(true);
  });

  it('reads a null built-in as null', async () => {
    expect(await runBody('return jwt == null', { builtins: { jwt: null } })).toBe(true);
  });

  it('rejects reassigning a built-in', async () => {
    await expect(runBody('jwt = 1', { builtins })).rejects.toThrow(/const/);
  });

  it('rejects changing a built-in object or list', async () => {
    await expect(runBody('jwt.sub = "x"', { builtins })).rejects.toThrow(/read-only/);
    await expect(runBody('jwt.claims.scope = "write"', { builtins })).rejects.toThrow(/read-only/);
    await expect(runBody('jwt.aud[0] = "x"', { builtins })).rejects.toThrow(/read-only/);
    await expect(runBody('var copy = jwt\ncopy.sub = "x"', { builtins })).rejects.toThrow(RuntimeError);
  });

  it('does not change the host value', async () => {
    const host = { sub: 'cli_1' };
    await expect(runBody('jwt.sub = "x"', { builtins: { jwt: host } })).rejects.toThrow(RuntimeError);
    expect(host.sub).toBe('cli_1');
  });

  it('copies fields out into ordinary variables', async () => {
    expect(await runBody('var sub = jwt.sub\nsub = sub + "!"\nreturn sub', { builtins })).toBe('cli_1!');
  });

  it('rejects declaring a variable with a built-in name', async () => {
    await expect(runBody('var jwt = 1', { builtins })).rejects.toThrow(/'jwt' is a built-in variable/);
    await expect(runBody('const jwt = 1', { builtins })).rejects.toThrow(/'jwt' is a built-in variable/);
    await expect(runBody('if (true) { var jwt = 1 }', { builtins })).rejects.toThrow(/'jwt' is a built-in variable/);
    await expect(runBody('var jwt = 1', { builtins: { jwt: null } })).rejects.toThrow(/'jwt' is a built-in variable/);
  });

  it('rejects a contract parameter with a built-in name', async () => {
    const script = 'contract path.to.C(jwt: string) { return jwt }';
    await expect(run(script, { parameters: { jwt: 'x' }, builtins })).rejects.toThrow(ParameterError);
  });

  it('leaves names free when no built-ins are passed', async () => {
    expect(await runBody('var jwt = 1\nreturn jwt')).toBe(1);
  });

  it('still lets a script change its own const objects', async () => {
    expect(await runBody('const o = {a: 1}\no.a = 2\nreturn o.a', { builtins })).toBe(2);
  });

  it('rejects invalid built-in names', async () => {
    await expect(runBody('return 1', { builtins: { 'not-a-name': 1 } })).rejects.toThrow(/Invalid built-in/);
    await expect(runBody('return 1', { builtins: { return: 1 } })).rejects.toThrow(/Invalid built-in/);
  });

  it('passes built-in fields to resource functions', async () => {
    let received: unknown;
    const echo: Resource = {
      path: 'path.to',
      name: 'Echo',
      functions: [
        {
          name: 'echo',
          parameters: [{ name: 'clientId', type: 'string' }],
          exec: async (args) => (received = args[0]?.value),
          returnType: 'string',
        },
      ],
    };
    const body = 'const e: path.to.Echo\nreturn e.echo(clientId: jwt.sub).value';
    expect(await runBody(body, { builtins, resourceResolver: createResourceResolver([echo]) })).toBe('cli_1');
    expect(received).toBe('cli_1');
  });
});
