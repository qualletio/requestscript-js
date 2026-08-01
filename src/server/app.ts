import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { LexError, ParameterError, ParseError, RequestScriptError, RuntimeError } from '../lang/errors.js';
import { interpret, interpretParsed } from '../lang/interpreter.js';
import { parseScript } from '../lang/parser.js';
import type { ResourceResolver } from '../lang/interpreter.js';
import { deleteContract, findContract, listContracts, saveContract } from './contracts.js';
import type { Database } from './db/index.js';

export interface AppOptions {
  db: Database;
  /** Host resources made available to every executed script. */
  resourceResolver: ResourceResolver;
  /**
   * Middleware (e.g. auth) installed ahead of every route, in order. Runs
   * before the routes' body parsing; a handler that ends the response stops
   * the request, and errors passed to next() are formatted by the JSON
   * error handler.
   */
  middleware?: RequestHandler[];
}

interface ContractRef {
  path: string;
  name: string;
  /** Version from a 'Name@<version>' segment; undefined targets the latest (or, for DELETE, every) version. */
  version?: string;
}

/** Dot-separated numbers, e.g. '2', '1.5', or '1.2.3'. */
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * Splits wildcard route segments into a contract path, name, and optional
 * '@<version>' suffix, responding with the appropriate error when malformed.
 */
function contractRefOrRespond(res: Response, splat: unknown): ContractRef | undefined {
  const segments = (Array.isArray(splat) ? splat.map(String) : String(splat ?? '').split('/')).filter(
    (segment) => segment.length > 0,
  );
  const last = segments.pop();
  if (!last) {
    sendError(res, 404, 'UnknownContract', 'No contract path given');
    return undefined;
  }
  const path = segments.join('.');
  const at = last.indexOf('@');
  if (at === -1) return { path, name: last };

  const name = last.slice(0, at);
  const version = last.slice(at + 1);
  if (!name || !VERSION_PATTERN.test(version)) {
    sendError(res, 400, 'InvalidVersion', `The contract version after '@' must be dot-separated numbers, e.g. '2' or '1.2.3'`);
    return undefined;
  }
  return { path, name, version };
}

/** Formats a contract reference for error messages, e.g. 'a.b.C@2'. */
function contractLabel(ref: ContractRef): string {
  const full = ref.path === '' ? ref.name : `${ref.path}.${ref.name}`;
  return ref.version === undefined ? full : `${full}@${ref.version}`;
}

function sendError(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({ error: { type, message } });
}

function sendScriptError(res: Response, error: unknown): void {
  if (error instanceof LexError || error instanceof ParseError) {
    sendError(res, 400, error.name, error.message);
  } else if (error instanceof ParameterError) {
    sendError(res, 400, error.name, error.message);
  } else if (error instanceof RuntimeError) {
    sendError(res, 422, error.name, error.message);
  } else {
    throw error;
  }
}

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function createApp(options: AppOptions): Express {
  const { db, resourceResolver, middleware = [] } = options;
  const app = express();
  for (const handler of middleware) {
    app.use(handler);
  }
  const scriptBody = express.text({ type: () => true, limit: '1mb' });
  const jsonBody = express.json({ limit: '1mb' });

  // Execute a one-off request script.
  app.post(
    '/run',
    scriptBody,
    wrap(async (req, res) => {
      const source = typeof req.body === 'string' ? req.body : '';
      try {
        const script = parseScript(source);
        if (script.declaration.kind !== 'request') {
          sendError(res, 400, 'InvalidScript', 'POST /run executes request scripts; save contracts via POST /contracts');
          return;
        }
        const result = await interpretParsed(script, { resourceResolver });
        res.json({ returnValue: result.returnValue ?? null });
      } catch (error) {
        sendScriptError(res, error);
      }
    }),
  );

  // Invoke a saved contract.
  app.post(
    '/run/*contract',
    jsonBody,
    wrap(async (req, res) => {
      const ref = contractRefOrRespond(res, req.params['contract']);
      if (!ref) return;
      const row = await findContract(db, ref.path, ref.name, ref.version);
      if (!row) {
        sendError(res, 404, 'UnknownContract', `No contract named '${contractLabel(ref)}' exists`);
        return;
      }

      const body: unknown = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        sendError(res, 400, 'InvalidBody', 'The request body must be a JSON object');
        return;
      }
      const parameters = (body as Record<string, unknown>)['parameters'] ?? {};
      if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
        sendError(res, 400, 'InvalidBody', `The 'parameters' key must be a JSON object`);
        return;
      }

      try {
        const result = await interpret(row.source, {
          resourceResolver,
          parameters: parameters as Record<string, unknown>,
        });
        res.json({ returnValue: result.returnValue ?? null });
      } catch (error) {
        sendScriptError(res, error);
      }
    }),
  );

  // Create or update a contract.
  app.post(
    '/contracts',
    scriptBody,
    wrap(async (req, res) => {
      const source = typeof req.body === 'string' ? req.body : '';
      try {
        const script = parseScript(source);
        if (script.declaration.kind !== 'contract') {
          sendError(res, 400, 'InvalidScript', 'POST /contracts saves contract scripts; run request scripts via POST /run');
          return;
        }
        const saved = await saveContract(db, script.declaration, source);
        if (!saved.created) {
          const label = contractLabel({ path: saved.path, name: saved.name, version: saved.version });
          sendError(
            res,
            409,
            'ContractExists',
            `Contract '${label}' already exists; contracts are immutable — save it again with a new version`,
          );
          return;
        }
        res.status(201).json({
          path: saved.path,
          name: saved.name,
          version: saved.version,
          parameters: saved.parameters,
        });
      } catch (error) {
        sendScriptError(res, error);
      }
    }),
  );

  // List saved contracts.
  app.get(
    '/contracts',
    wrap(async (_req, res) => {
      const rows = await listContracts(db);
      res.json({
        contracts: rows.map((row) => ({
          path: row.path,
          name: row.name,
          version: row.version,
          parameters: row.parameters,
        })),
      });
    }),
  );

  // Delete a contract.
  app.delete(
    '/contracts/*contract',
    wrap(async (req, res) => {
      const ref = contractRefOrRespond(res, req.params['contract']);
      if (!ref) return;
      const deleted = await deleteContract(db, ref.path, ref.name, ref.version);
      if (!deleted) {
        sendError(res, 404, 'UnknownContract', `No contract named '${contractLabel(ref)}' exists`);
        return;
      }
      res.status(204).end();
    }),
  );

  // Fallbacks and error handling.
  app.use((req, res) => {
    sendError(res, 404, 'NotFound', `No route for ${req.method} ${req.path}`);
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && 'status' in error && (error as { status?: number }).status === 400) {
      sendError(res, 400, 'InvalidBody', 'The request body is not valid JSON');
      return;
    }
    if (error instanceof RequestScriptError) {
      sendScriptError(res, error);
      return;
    }
    console.error(error);
    sendError(res, 500, 'InternalError', 'Internal server error');
  });

  return app;
}
