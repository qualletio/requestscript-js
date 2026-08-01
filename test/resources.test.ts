import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/lang/decimal.js';
import { RuntimeError } from '../src/lang/errors.js';
import { createResourceResolver } from '../src/lang/interpreter.js';
import type { Resource, ResourceFunctionCallParameter } from '../src/lang/resource.js';
import { runBody } from './helpers.js';

function arg(args: ResourceFunctionCallParameter[], name: string): unknown {
  return args.find((parameter) => parameter.name === name)?.value;
}

const addResource: Resource = {
  path: 'path.to',
  name: 'AddResource',
  functions: [
    {
      name: 'add',
      parameters: [
        { name: 'first', type: 'int32' },
        { name: 'second', type: 'int32' },
      ],
      exec: (args) => Number(arg(args, 'first')) + Number(arg(args, 'second')),
      returnType: 'int32',
    },
  ],
};

describe('interpreter: resources', () => {
  it('runs the guide example end to end', async () => {
    const body = `const addResource: path.to.AddResource
      const num1 = 2
      const num2 = 3
      return addResource.add(first: num1, second: num2)`;
    expect(await runBody(body, { resourceResolver: createResourceResolver([addResource]) })).toBe(5);
  });

  it('accepts named arguments in any order', async () => {
    const body = `const r: path.to.AddResource
      return r.add(second: 3, first: 2)`;
    expect(await runBody(body, { resourceResolver: createResourceResolver([addResource]) })).toBe(5);
  });

  it('rejects unknown resources', async () => {
    await expect(runBody('const r: path.to.Missing\nreturn 1')).rejects.toThrow(
      /Unknown resource 'path.to.Missing'/,
    );
  });

  it('rejects unknown functions', async () => {
    const body = 'const r: path.to.AddResource\nreturn r.subtract(first: 1, second: 2)';
    await expect(runBody(body, { resourceResolver: createResourceResolver([addResource]) })).rejects.toThrow(/has no function 'subtract'/);
  });

  it('rejects missing, unknown, and badly typed arguments', async () => {
    const opts = { resourceResolver: createResourceResolver([addResource]) };
    await expect(runBody('const r: path.to.AddResource\nreturn r.add(first: 1)', opts)).rejects.toThrow(
      /Missing argument 'second'/,
    );
    await expect(
      runBody('const r: path.to.AddResource\nreturn r.add(first: 1, second: 2, third: 3)', opts),
    ).rejects.toThrow(/has no parameter 'third'/);
    await expect(
      runBody('const r: path.to.AddResource\nreturn r.add(first: "x", second: 2)', opts),
    ).rejects.toThrow(RuntimeError);
  });

  it('supports path-less resources', async () => {
    const resource: Resource = {
      path: '',
      name: 'Ping',
      functions: [{ name: 'ping', parameters: [], exec: () => 'pong', returnType: 'string' }],
    };
    expect(await runBody('const p: Ping\nreturn p.ping()', { resourceResolver: createResourceResolver([resource]) })).toBe('pong');
  });

  it('supports void functions and returns null for them', async () => {
    const calls: unknown[][] = [];
    const resource: Resource = {
      path: '',
      name: 'Log',
      functions: [
        {
          name: 'log',
          parameters: [{ name: 'message', type: 'string' }],
          exec: (args) => {
            calls.push(args.map((parameter) => parameter.value));
          },
          returnType: 'void',
        },
      ],
    };
    expect(await runBody('const l: Log\nreturn l.log(message: "hi")', { resourceResolver: createResourceResolver([resource]) })).toBeNull();
    expect(calls).toEqual([['hi']]);
  });

  it('supports async exec functions', async () => {
    const resource: Resource = {
      path: '',
      name: 'Async',
      functions: [
        {
          name: 'get',
          parameters: [],
          exec: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return 42;
          },
          returnType: 'int32',
        },
      ],
    };
    expect(await runBody('const a: Async\nreturn a.get()', { resourceResolver: createResourceResolver([resource]) })).toBe(42);
  });

  it('converts values in both directions, including int64, decimal, lists, and objects', async () => {
    const seen: Record<string, unknown> = {};
    const resource: Resource = {
      path: '',
      name: 'Echo',
      functions: [
        {
          name: 'echo',
          parameters: [
            { name: 'big', type: 'int64' },
            { name: 'price', type: 'decimal' },
            { name: 'tags', type: '[]string' },
            { name: 'meta', type: 'object' },
          ],
          exec: (args) => {
            for (const parameter of args) seen[parameter.name] = parameter.value;
            return {
              big: arg(args, 'big'),
              price: arg(args, 'price'),
              first: (arg(args, 'tags') as string[])[0],
            };
          },
          returnType: 'object',
        },
      ],
    };
    const body = `const e: Echo
      return e.echo(big: 9223372036854775807, price: 19.99, tags: ["a", "b"], meta: { ok: true })`;
    const result = await runBody(body, { resourceResolver: createResourceResolver([resource]) });
    expect(seen['big']).toBe(9223372036854775807n);
    expect(seen['price']).toBeInstanceOf(Decimal);
    expect((seen['price'] as Decimal).toString()).toBe('19.99');
    expect(seen['tags']).toEqual(['a', 'b']);
    expect(seen['meta']).toEqual({ ok: true });
    expect(result).toEqual({ big: '9223372036854775807', price: 19.99, first: 'a' });
  });

  it('validates the returned value against the declared return type', async () => {
    const resource: Resource = {
      path: '',
      name: 'Bad',
      functions: [{ name: 'get', parameters: [], exec: () => 'not a number', returnType: 'int32' }],
    };
    await expect(runBody('const b: Bad\nreturn b.get()', { resourceResolver: createResourceResolver([resource]) })).rejects.toThrow(RuntimeError);
  });

  it('wraps host errors as runtime errors', async () => {
    const resource: Resource = {
      path: '',
      name: 'Boom',
      functions: [
        {
          name: 'explode',
          parameters: [],
          exec: () => {
            throw new Error('kaboom');
          },
          returnType: 'void',
        },
      ],
    };
    await expect(runBody('const b: Boom\nreturn b.explode()', { resourceResolver: createResourceResolver([resource]) })).rejects.toThrow(
      /Resource function 'explode' failed: kaboom/,
    );
  });

  it('rejects calling functions on non-resources and referencing functions without calling', async () => {
    await expect(runBody('var o = { a: 1 }\nreturn o.a(x: 1)', { resourceResolver: createResourceResolver([addResource]) })).rejects.toThrow(
      /Cannot call 'a'/,
    );
    await expect(runBody('const r: path.to.AddResource\nreturn r.add', { resourceResolver: createResourceResolver([addResource]) })).rejects.toThrow(
      /must be called/,
    );
  });

  it('rejects using a resource reference as a value', async () => {
    const opts = { resourceResolver: createResourceResolver([addResource]) };
    await expect(runBody('const r: path.to.AddResource\nreturn r', opts)).rejects.toThrow(
      /cannot be used as a value/,
    );
    await expect(runBody('const r: path.to.AddResource\nvar x = r', opts)).rejects.toThrow(RuntimeError);
    await expect(runBody('const r: path.to.AddResource\nreturn [r]', opts)).rejects.toThrow(RuntimeError);
  });
});
