import type { EventRef, Script, Statement } from './ast.js';

/**
 * Every event a script's `emit` statements name, in source order, including those in branches that may not
 * run. A host checks them before it accepts the script, since a script has no other way to emit.
 */
export function emittedEvents(script: Script): EventRef[] {
  return statementsEvents(script.body);
}

function statementsEvents(statements: Statement[]): EventRef[] {
  return statements.flatMap((statement): EventRef[] => {
    switch (statement.kind) {
      case 'emit':
        return [statement.event];
      case 'if':
        return [
          ...statement.branches.flatMap((branch) => statementsEvents(branch.body)),
          ...statementsEvents(statement.elseBody ?? []),
        ];
      default:
        return [];
    }
  });
}
