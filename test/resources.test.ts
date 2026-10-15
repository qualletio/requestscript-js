import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/lang/decimal.js';
import { RuntimeError } from '../src/lang/errors.js';
import {
  createResourceResolver,
  defaultResourceInvoker,
  type ResourceInvoker,
} from '../src/lang/interpreter.js';
import { resourceError, type Resource, type ResourceFunctionCallParameter } from '../src/lang/resource.js';
import { runBody } from './helpers.js';

function arg(args: ResourceFunctionCallParameter[], name: string): unknown {
  return args.find((parameter) => parameter.name === name)?.value;
}

/** The shape every resource call evaluates to. */
function ok(value: unknown): unknown {
  return { value, error: null };
}

function failed(message: string): unknown {
  return { value: null, error: { message } };
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
      exec: async (args) => Number(arg(args, 'first')) + Number(arg(args, 'second')),
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
    expect(await runBody(body, { resourceResolver: createResourceResolver([addResource]) })).toEqual(ok(5));
  });

  it('exposes the return value under value', async () => {
    const body = `const r: path.to.AddResource
      const sum = r.add(first: 2, second: 3)
      return sum.value + 1`;
    expect(await runBody(body, { resourceResolver: createResourceResolver([addResource]) })).toBe(6);
  });

  it('accepts named arguments in any order', async () => {
    const body = `const r: path.to.AddResource
      return r.add(second: 3, first: 2)`;
    expect(await runBody(body, { resourceResolver: createResourceResolver([addResource]) })).toEqual(ok(5));
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
      functions: [{ name: 'ping', parameters: [], exec: async () => 'pong', returnType: 'string' }],
    };
    expect(await runBody('const p: Ping\nreturn p.ping()', { resourceResolver: createResourceResolver([resource]) })).toEqual(
      ok('pong'),
    );
  });

  it('supports void functions and returns a null value for them', async () => {
    const calls: unknown[][] = [];
    const resource: Resource = {
      path: '',
      name: 'Log',
      functions: [
        {
          name: 'log',
          parameters: [{ name: 'message', type: 'string' }],
          exec: async (args) => {
            calls.push(args.map((parameter) => parameter.value));
          },
          returnType: 'void',
        },
      ],
    };
    expect(await runBody('const l: Log\nreturn l.log(message: "hi")', { resourceResolver: createResourceResolver([resource]) })).toEqual(
      ok(null),
    );
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
    expect(await runBody('const a: Async\nreturn a.get()', { resourceResolver: createResourceResolver([resource]) })).toEqual(
      ok(42),
    );
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
          exec: async (args) => {
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
    expect(result).toEqual(ok({ big: '9223372036854775807', price: 19.99, first: 'a' }));
  });

  it('validates the returned value against the declared return type', async () => {
    const resource: Resource = {
      path: '',
      name: 'Bad',
      functions: [{ name: 'get', parameters: [], exec: async () => 'not a number', returnType: 'int32' }],
    };
    await expect(runBody('const b: Bad\nreturn b.get()', { resourceResolver: createResourceResolver([resource]) })).rejects.toThrow(RuntimeError);
  });

  it('surfaces a thrown host error as the error field instead of failing the script', async () => {
    const resource: Resource = {
      path: '',
      name: 'Boom',
      functions: [
        {
          name: 'explode',
          parameters: [],
          exec: async () => {
            throw new Error('kaboom');
          },
          returnType: 'int32',
        },
      ],
    };
    const opts = { resourceResolver: createResourceResolver([resource]) };
    expect(await runBody('const b: Boom\nreturn b.explode()', opts)).toEqual(failed('kaboom'));

    const body = `const b: Boom
      const result = b.explode()
      if (result.error != null) {
          return result.error.message
      }
      return result.value`;
    expect(await runBody(body, opts)).toBe('kaboom');
  });

  it('lets the script keep running after a failed call', async () => {
    const resource: Resource = {
      path: '',
      name: 'Flaky',
      functions: [
        {
          name: 'get',
          parameters: [{ name: 'fail', type: 'boolean' }],
          exec: async (args) => {
            if (arg(args, 'fail') === true) throw new Error('upstream 503');
            return 7;
          },
          returnType: 'int32',
        },
      ],
    };
    const body = `const f: Flaky
      const first = f.get(fail: true)
      const second = f.get(fail: false)
      return { failed: first.error.message, then: second.value }`;
    expect(await runBody(body, { resourceResolver: createResourceResolver([resource]) })).toEqual({
      failed: 'upstream 503',
      then: 7,
    });
  });

  it('reports an error for a void function too', async () => {
    const resource: Resource = {
      path: '',
      name: 'Log',
      functions: [
        {
          name: 'log',
          parameters: [],
          exec: async () => {
            throw new Error('disk full');
          },
          returnType: 'void',
        },
      ],
    };
    expect(await runBody('const l: Log\nreturn l.log()', { resourceResolver: createResourceResolver([resource]) })).toEqual(
      failed('disk full'),
    );
  });

  it('reads error as null on success', async () => {
    const body = `const r: path.to.AddResource
      const sum = r.add(first: 2, second: 3)
      if (sum.error != null) {
          return "failed"
      }
      return sum.value`;
    expect(await runBody(body, { resourceResolver: createResourceResolver([addResource]) })).toBe(5);
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

describe('interpreter: resource invoker', () => {
  const body = `const r: path.to.AddResource
    return r.add(first: 2, second: 3)`;

  it('routes calls through a custom invoker instead of exec', async () => {
    const calls: { resource: Resource; functionName: string; parameters: ResourceFunctionCallParameter[] }[] = [];
    const invoker: ResourceInvoker = {
      async invoke(resource, functionName, parameters) {
        calls.push({ resource, functionName, parameters });
        return { value: 99, error: null };
      },
    };
    const opts = { resourceResolver: createResourceResolver([addResource]), resourceInvoker: invoker };
    expect(await runBody(body, opts)).toEqual(ok(99));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resource).toBe(addResource);
    expect(calls[0]!.functionName).toBe('add');
    expect(calls[0]!.parameters).toEqual([
      { name: 'first', value: 2 },
      { name: 'second', value: 3 },
    ]);
  });

  it('validates the custom invoker value against the declared return type', async () => {
    const invoker: ResourceInvoker = { invoke: async () => ({ value: 'not a number', error: null }) };
    const opts = { resourceResolver: createResourceResolver([addResource]), resourceInvoker: invoker };
    await expect(runBody(body, opts)).rejects.toThrow(RuntimeError);
  });

  it('surfaces an error the invoker returns, without checking the return type', async () => {
    const invoker: ResourceInvoker = { invoke: async () => resourceError('unreachable host') };
    const opts = { resourceResolver: createResourceResolver([addResource]), resourceInvoker: invoker };
    expect(await runBody(body, opts)).toEqual(failed('unreachable host'));
  });

  it('surfaces a thrown invoker error as the error field', async () => {
    const invoker: ResourceInvoker = {
      invoke: async () => {
        throw new Error('unreachable host');
      },
    };
    const opts = { resourceResolver: createResourceResolver([addResource]), resourceInvoker: invoker };
    expect(await runBody(body, opts)).toEqual(failed('unreachable host'));
  });

  it('rejects an invoker result that is not a value/error object', async () => {
    const opts = (invoke: ResourceInvoker['invoke']) => ({
      resourceResolver: createResourceResolver([addResource]),
      resourceInvoker: { invoke },
    });
    await expect(runBody(body, opts(async () => 5 as unknown as never))).rejects.toThrow(
      /'add' returned a number, expected an object with 'value' and 'error'/,
    );
    await expect(runBody(body, opts(async () => null as unknown as never))).rejects.toThrow(
      /'add' returned null, expected an object/,
    );
    await expect(runBody(body, opts(async () => ({}) as never))).rejects.toThrow(
      /'add' returned an object with neither 'value' nor 'error'/,
    );
    await expect(runBody(body, opts(async () => ({ value: null, error: { code: 1 } }) as never))).rejects.toThrow(
      /'add' returned an error without a string 'message'/,
    );
  });

  it('validates the function and arguments before calling the invoker', async () => {
    const calls: string[] = [];
    const invoker: ResourceInvoker = {
      invoke: async (_resource, functionName) => {
        calls.push(functionName);
        return { value: 0, error: null };
      },
    };
    const opts = { resourceResolver: createResourceResolver([addResource]), resourceInvoker: invoker };
    await expect(runBody('const r: path.to.AddResource\nreturn r.subtract(first: 1, second: 2)', opts)).rejects.toThrow(
      /has no function 'subtract'/,
    );
    await expect(runBody('const r: path.to.AddResource\nreturn r.add(first: 1)', opts)).rejects.toThrow(
      /Missing argument 'second'/,
    );
    expect(calls).toEqual([]);
  });

  it('defaultResourceInvoker executes the resource function and wraps its return', async () => {
    const result = await defaultResourceInvoker.invoke(addResource, 'add', [
      { name: 'first', value: 2 },
      { name: 'second', value: 3 },
    ]);
    expect(result).toEqual({ value: 5, error: null });
  });

  it('defaultResourceInvoker reports a void function as a null value', async () => {
    const resource: Resource = {
      path: '',
      name: 'Noop',
      functions: [{ name: 'noop', parameters: [], exec: async () => undefined, returnType: 'void' }],
    };
    expect(await defaultResourceInvoker.invoke(resource, 'noop', [])).toEqual({ value: null, error: null });
  });

  it('defaultResourceInvoker rejects unknown functions', async () => {
    await expect(defaultResourceInvoker.invoke(addResource, 'subtract', [])).rejects.toThrow(
      /Resource 'path.to.AddResource' has no function 'subtract'/,
    );
  });
});
