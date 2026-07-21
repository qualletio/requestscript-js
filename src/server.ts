import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Resource } from './lang/resource.js';
import { createApp } from './server/app.js';
import { databaseUrl, schema } from './server/db/index.js';
import { runMigrations } from './server/db/migrate.js';

/**
 * Host resources exposed to scripts on this server. Add entries here (or
 * build the list from configuration) to let scripts call into TypeScript.
 */
const resources: Resource[] = [];

async function main(): Promise<void> {
  const connectionString = databaseUrl();
  await runMigrations(connectionString);

  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  const app = createApp({ db, resources });

  const port = Number(process.env['PORT'] ?? 3000);
  app.listen(port, () => {
    console.log(`Requestscript server listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
