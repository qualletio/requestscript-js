import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { databaseUrl } from './index.js';

/** Applies all pending migrations from ./drizzle to the configured database. */
export async function runMigrations(connectionString: string = databaseUrl()): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
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
