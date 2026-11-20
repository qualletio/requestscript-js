import type { EventRef, Script } from './ast.js';
import { walkStatements } from './functions.js';

/**
 * Every event a script's `emit` statements name, in source order, including those in branches and functions
 * that may not run. A host checks them before it accepts the script, since a script has no other way to emit.
 */
export function emittedEvents(script: Script): EventRef[] {
  const events: EventRef[] = [];
  walkStatements(script, (statement) => {
    if (statement.kind === 'emit') events.push(statement.event);
  });
  return events;
}
