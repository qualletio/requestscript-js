#!/usr/bin/env node
import { startServer } from '../server/index.js';

startServer()
  .then(({ port }) => {
    console.log(`Requestscript server listening on http://localhost:${port}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
