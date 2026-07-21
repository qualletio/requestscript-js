import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

/**
 * The database handle used by the server. Both the node-postgres driver
 * (production) and the PGlite driver (tests) satisfy this type.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export { schema };

export const DEFAULT_DATABASE_URL = 'postgres://requestscript:requestscript@localhost:5432/requestscript';

export function databaseUrl(): string {
  return process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
}
