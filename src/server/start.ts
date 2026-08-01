import { drizzle } from 'drizzle-orm/node-postgres';
import type { Express, RequestHandler } from 'express';
import type { Server } from 'node:http';
import pg from 'pg';
import { defaultResourceResolver, type ResourceResolver } from '../lang/interpreter.js';
import { createApp } from './app.js';
import { databaseUrl, schema } from './db/index.js';
import { runMigrations } from './db/migrate.js';

export interface StartServerOptions {
  /** Postgres connection string; defaults to DATABASE_URL or the local dev default. */
  connectionString?: string;
  /** Port to listen on; defaults to PORT or 3000. Use 0 for an ephemeral port. */
  port?: number;
  /** Resolves host resources referenced by scripts; resolves nothing when omitted. */
  resourceResolver?: ResourceResolver;
  /** Middleware (e.g. auth) installed ahead of every route; see AppOptions.middleware. */
  middleware?: RequestHandler[];
  /** Apply pending migrations before starting. Defaults to true. */
  migrate?: boolean;
}

export interface RunningServer {
  app: Express;
  server: Server;
  /** The port actually bound (useful when starting with port 0). */
  port: number;
  /** Stops the HTTP server and closes the database pool. */
  close(): Promise<void>;
}

/**
 * Connects to Postgres, applies migrations, and starts the Requestscript
 * HTTP server. For finer control (custom drivers, no listening socket),
 * use createApp directly.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const connectionString = options.connectionString ?? databaseUrl();
  if (options.migrate ?? true) {
    await runMigrations(connectionString);
  }

  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  const app = createApp({
    db,
    resourceResolver: options.resourceResolver ?? defaultResourceResolver,
    middleware: options.middleware ?? [],
  });

  const requestedPort = options.port ?? Number(process.env['PORT'] ?? 3000);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(requestedPort, () => resolve(listening));
    listening.on('error', reject);
  }).catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

  return {
    app,
    server,
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await pool.end();
    },
  };
}
