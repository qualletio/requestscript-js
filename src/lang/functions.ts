import type { FunctionDecl, Script, Statement } from './ast.js';

/** The name of an event contract's handler, the function the host runs with each event. */
export const EVENT_HANDLER = 'on';

/**
 * The functions a host may run a contract by: its `pub` functions, or an event contract's handler, `on`. Empty
 * for every other script.
 */
export function entrypoints(script: Script): FunctionDecl[] {
  if (script.declaration.kind !== 'contract') return [];
  if (script.declaration.consumes) return script.functions.filter((fn) => fn.name === EVENT_HANDLER);
  return script.functions.filter((fn) => fn.pub);
}

/** The entrypoint called `name`, or undefined when the script has none by that name. */
export function entrypoint(script: Script, name: string): FunctionDecl | undefined {
  return entrypoints(script).find((fn) => fn.name === name);
}

/**
 * Visits every statement a script holds, in source order: its top-level statements, then each function's,
 * descending into `if` branches, including those that may not run. `fn` is the function the statement is in,
 * or undefined at a script's top level.
 */
export function walkStatements(script: Script, visit: (statement: Statement, fn: FunctionDecl | undefined) => void): void {
  const walk = (statements: Statement[], fn: FunctionDecl | undefined): void => {
    for (const statement of statements) {
      visit(statement, fn);
      if (statement.kind === 'if') {
        for (const branch of statement.branches) walk(branch.body, fn);
        walk(statement.elseBody ?? [], fn);
      }
    }
  };
  walk(script.body, undefined);
  for (const fn of script.functions) walk(fn.body, fn);
}
