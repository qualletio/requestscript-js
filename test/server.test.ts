import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createResourceResolver } from '../src/lang/interpreter.js';
import type { Resource } from '../src/lang/resource.js';
import { createApp } from '../src/server/app.js';
import { schema } from '../src/server/db/index.js';

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
      exec: (args) =>
        Number(args.find((parameter) => parameter.name === 'first')?.value) +
        Number(args.find((parameter) => parameter.name === 'second')?.value),
      returnType: 'int32',
    },
  ],
};

let client: PGlite;
let app: Express;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  app = createApp({ db, resourceResolver: createResourceResolver([addResource]) });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(schema.contracts);
});

function postScript(url: string, source: string) {
  return request(app).post(url).set('Content-Type', 'text/plain').send(source);
}

describe('POST /run', () => {
  it('executes a request script', async () => {
    const response = await postScript('/run', 'request MyRequest { return "Hello World!" }');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ returnValue: 'Hello World!' });
  });

  it('returns null when the script has no return statement', async () => {
    const response = await postScript('/run', 'request R { var x = 1 }');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ returnValue: null });
  });

  it('can call resources', async () => {
    const source = `request R {
      const addResource: path.to.AddResource
      return addResource.add(first: 2, second: 3)
    }`;
    const response = await postScript('/run', source);
    expect(response.body).toEqual({ returnValue: 5 });
  });

  it('rejects contract scripts', async () => {
    const response = await postScript('/run', 'contract C { return 1 }');
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('InvalidScript');
  });

  it('reports parse errors with 400', async () => {
    const response = await postScript('/run', 'request R { return }}}');
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('ParseError');
    expect(response.body.error.message).toContain('line');
  });

  it('reports runtime errors with 422', async () => {
    const response = await postScript('/run', 'request R { return 1 / 0 }');
    expect(response.status).toBe(422);
    expect(response.body.error.type).toBe('RuntimeError');
    expect(response.body.error.message).toContain('Division by zero');
  });

  it('encodes complex return values as JSON', async () => {
    const response = await postScript('/run', 'request R { return { list: [1, 2.5, "x"], big: 9223372036854775807 } }');
    expect(response.body).toEqual({
      returnValue: { list: [1, 2.5, 'x'], big: '9223372036854775807' },
    });
  });
});

describe('POST /contracts', () => {
  it('creates a contract and returns its metadata', async () => {
    const response = await postScript(
      '/contracts',
      'contract path.to.MyContract(param1: string) { return "Hello ${param1}!" }',
    );
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      path: 'path.to',
      name: 'MyContract',
      version: '1',
      parameters: [{ name: 'param1', type: 'string' }],
    });
  });

  it('creates a contract with a declared version', async () => {
    const response = await postScript('/contracts', 'contract a.b.C@7 { return 7 }');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ path: 'a.b', name: 'C', version: '7', parameters: [] });
  });

  it('creates contracts with decimal and semantic versions', async () => {
    const semver = await postScript('/contracts', 'contract a.b.C@1.2.3 { return 1 }');
    expect(semver.status).toBe(201);
    expect(semver.body).toEqual({ path: 'a.b', name: 'C', version: '1.2.3', parameters: [] });

    const decimal = await postScript('/contracts', 'contract a.b.C@1.5 { return 1 }');
    expect(decimal.status).toBe(201);
    expect(decimal.body.version).toBe('1.5');
  });

  it('rejects re-saving an existing version; contracts are immutable', async () => {
    await postScript('/contracts', 'contract a.b.C { return 1 }');
    const sameVersion = await postScript('/contracts', 'contract a.b.C { return 2 }');
    expect(sameVersion.status).toBe(409);
    expect(sameVersion.body.error.type).toBe('ContractExists');

    const explicitSameVersion = await postScript('/contracts', 'contract a.b.C@1 { return 2 }');
    expect(explicitSameVersion.status).toBe(409);

    const invoked = await request(app).post('/run/a/b/C').send({});
    expect(invoked.body).toEqual({ returnValue: 1 });
  });

  it('saves a new version alongside the old one', async () => {
    await postScript('/contracts', 'contract a.b.C { return 1 }');
    const response = await postScript('/contracts', 'contract a.b.C@2 { return 2 }');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ path: 'a.b', name: 'C', version: '2', parameters: [] });
  });

  it('allows the same name at different paths', async () => {
    await postScript('/contracts', 'contract a.C { return "a" }');
    await postScript('/contracts', 'contract b.C { return "b" }');
    expect((await request(app).post('/run/a/C').send({})).body).toEqual({ returnValue: 'a' });
    expect((await request(app).post('/run/b/C').send({})).body).toEqual({ returnValue: 'b' });
  });

  it('rejects request scripts', async () => {
    const response = await postScript('/contracts', 'request R { return 1 }');
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('InvalidScript');
  });

  it('rejects invalid scripts', async () => {
    const response = await postScript('/contracts', 'contract C { var = }');
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('ParseError');
  });
});

describe('POST /run/<path>/<name>', () => {
  it('invokes a contract with parameters', async () => {
    await postScript('/contracts', 'contract path.to.MyContract(param1: string) { return "Hello ${param1}!" }');
    const response = await request(app)
      .post('/run/path/to/MyContract')
      .send({ parameters: { param1: 'World' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ returnValue: 'Hello World!' });
  });

  it('invokes a parameterless contract with no body', async () => {
    await postScript('/contracts', 'contract MyParameterlessContract { return "ok" }');
    const response = await request(app).post('/run/MyParameterlessContract');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ returnValue: 'ok' });
  });

  it('contracts can use resources', async () => {
    await postScript(
      '/contracts',
      'contract math.Sum(a: int32, b: int32) {\nconst r: path.to.AddResource\nreturn r.add(first: a, second: b)\n}',
    );
    const response = await request(app).post('/run/math/Sum').send({ parameters: { a: 20, b: 22 } });
    expect(response.body).toEqual({ returnValue: 42 });
  });

  it('invokes the latest version by default and a pinned version via @', async () => {
    await postScript('/contracts', 'contract a.C { return 1 }');
    await postScript('/contracts', 'contract a.C@3 { return 3 }');
    expect((await request(app).post('/run/a/C').send({})).body).toEqual({ returnValue: 3 });
    expect((await request(app).post('/run/a/C@1').send({})).body).toEqual({ returnValue: 1 });
    expect((await request(app).post('/run/a/C@3').send({})).body).toEqual({ returnValue: 3 });
  });

  it('orders versions numerically per segment, not lexically', async () => {
    await postScript('/contracts', 'contract a.C@1.9 { return 19 }');
    await postScript('/contracts', 'contract a.C@1.10 { return 110 }');
    await postScript('/contracts', 'contract a.C@1.2.99 { return 1299 }');
    expect((await request(app).post('/run/a/C').send({})).body).toEqual({ returnValue: 110 });
    expect((await request(app).post('/run/a/C@1.9').send({})).body).toEqual({ returnValue: 19 });
    expect((await request(app).post('/run/a/C@1.2.99').send({})).body).toEqual({ returnValue: 1299 });
  });

  it('returns 404 for unknown contracts', async () => {
    const response = await request(app).post('/run/no/such/Contract').send({});
    expect(response.status).toBe(404);
    expect(response.body.error.type).toBe('UnknownContract');
  });

  it('returns 404 for unknown versions of an existing contract', async () => {
    await postScript('/contracts', 'contract a.C { return 1 }');
    const response = await request(app).post('/run/a/C@2').send({});
    expect(response.status).toBe(404);
    expect(response.body.error.message).toContain("'a.C@2'");
  });

  it('rejects malformed version suffixes', async () => {
    await postScript('/contracts', 'contract a.C { return 1 }');
    for (const suffix of ['@', '@x', '@1.', '@.1', '@1..2', '@1.2.x']) {
      const response = await request(app).post(`/run/a/C${encodeURIComponent(suffix)}`).send({});
      expect(response.status).toBe(400);
      expect(response.body.error.type).toBe('InvalidVersion');
    }
  });

  it('rejects missing or invalid parameters with 400', async () => {
    await postScript('/contracts', 'contract Greet(name: string) { return name }');
    const missing = await request(app).post('/run/Greet').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.type).toBe('ParameterError');

    const wrongType = await request(app).post('/run/Greet').send({ parameters: { name: 42 } });
    expect(wrongType.status).toBe(400);

    const extra = await request(app).post('/run/Greet').send({ parameters: { name: 'x', more: 1 } });
    expect(extra.status).toBe(400);
  });

  it('rejects non-object parameters', async () => {
    await postScript('/contracts', 'contract Greet(name: string) { return name }');
    const response = await request(app).post('/run/Greet').send({ parameters: [1, 2] });
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('InvalidBody');
  });

  it('reports contract runtime errors with 422', async () => {
    await postScript('/contracts', 'contract Div(n: int32) { return 1 / n }');
    const response = await request(app).post('/run/Div').send({ parameters: { n: 0 } });
    expect(response.status).toBe(422);
  });

  it('rejects malformed JSON bodies', async () => {
    await postScript('/contracts', 'contract Greet(name: string) { return name }');
    const response = await request(app)
      .post('/run/Greet')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('InvalidBody');
  });
});

describe('GET /contracts and DELETE /contracts', () => {
  it('lists saved contracts including every version', async () => {
    await postScript('/contracts', 'contract a.One { return 1 }');
    await postScript('/contracts', 'contract a.One@2 { return 2 }');
    await postScript('/contracts', 'contract b.Two(x: []int32) { return x }');
    const response = await request(app).get('/contracts');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      contracts: [
        { path: 'a', name: 'One', version: '1', parameters: [] },
        { path: 'a', name: 'One', version: '2', parameters: [] },
        { path: 'b', name: 'Two', version: '1', parameters: [{ name: 'x', type: '[]int32' }] },
      ],
    });
  });

  it('deletes all versions of a contract by name', async () => {
    await postScript('/contracts', 'contract a.One { return 1 }');
    await postScript('/contracts', 'contract a.One@2 { return 2 }');
    expect((await request(app).delete('/contracts/a/One')).status).toBe(204);
    expect((await request(app).post('/run/a/One').send({})).status).toBe(404);
    expect((await request(app).delete('/contracts/a/One')).status).toBe(404);
  });

  it('deletes a single version via @', async () => {
    await postScript('/contracts', 'contract a.One { return 1 }');
    await postScript('/contracts', 'contract a.One@2 { return 2 }');
    expect((await request(app).delete('/contracts/a/One@2')).status).toBe(204);
    expect((await request(app).post('/run/a/One').send({})).body).toEqual({ returnValue: 1 });
    expect((await request(app).delete('/contracts/a/One@2')).status).toBe(404);
  });
});

describe('custom middleware', () => {
  it('runs supplied middleware ahead of every route', async () => {
    const guarded = createApp({
      db,
      resourceResolver: createResourceResolver([]),
      middleware: [
        (req, res, next) => {
          if (req.headers['authorization'] !== 'Bearer secret') {
            res.status(401).json({ error: { type: 'Unauthorized', message: 'Missing or invalid token' } });
            return;
          }
          next();
        },
      ],
    });

    const denied = await request(guarded).post('/run').set('Content-Type', 'text/plain').send('request R { return 1 }');
    expect(denied.status).toBe(401);
    expect(denied.body.error.type).toBe('Unauthorized');
    expect((await request(guarded).get('/contracts')).status).toBe(401);

    const allowed = await request(guarded)
      .post('/run')
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'text/plain')
      .send('request R { return 1 }');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ returnValue: 1 });
  });

  it('applies middleware in order and lets it decorate the request', async () => {
    const order: string[] = [];
    const ordered = createApp({
      db,
      resourceResolver: createResourceResolver([]),
      middleware: [
        (_req, _res, next) => {
          order.push('first');
          next();
        },
        (_req, _res, next) => {
          order.push('second');
          next();
        },
      ],
    });
    await request(ordered).get('/contracts');
    expect(order).toEqual(['first', 'second']);
  });

  it('formats middleware errors with the JSON error handler', async () => {
    const failing = createApp({
      db,
      resourceResolver: createResourceResolver([]),
      middleware: [(_req, _res, next) => next(new Error('boom'))],
    });
    const response = await request(failing).get('/contracts');
    expect(response.status).toBe(500);
    expect(response.body.error.type).toBe('InternalError');
  });
});

describe('fallback routes', () => {
  it('returns 404 JSON for unknown routes', async () => {
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.type).toBe('NotFound');
  });
});
