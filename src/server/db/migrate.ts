import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl } from './index.js';

/**
 * The bundled migrations, resolved relative to this module so they are found
 * both in a checkout and when the package is installed as a dependency.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/** Applies all pending bundled migrations to the configured database. */
export async function runMigrations(connectionString: string = databaseUrl()): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// Allow `pnpm db:migrate` to run this file directly.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied');
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
