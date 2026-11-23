import type { FunctionDecl, Script, Statement } from './ast.js';
import { walkNestedStatements } from './walk.js';

/** The name of an event contract's handler, the function the host runs with each event. */
export const EVENT_HANDLER = 'on';

/** The name of a rendering's entrypoint, which builds its UI. */
export const RENDER_FUNCTION = 'render';

/**
 * The functions a host may run a contract by: its `pub` functions, or an event contract's handler, `on`. For a
 * rendering, its `render`. Empty for every other script.
 */
export function entrypoints(script: Script): FunctionDecl[] {
  if (script.declaration.kind === 'rendering') return script.functions.filter((fn) => fn.pub);
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
 * descending into `if` branches, a rendering's component children and the bodies of its lambdas, including
 * those that may not run. `fn` is the function the statement is in, or undefined at a script's top level.
 */
export function walkStatements(script: Script, visit: (statement: Statement, fn: FunctionDecl | undefined) => void): void {
  walkNestedStatements(script.body, (statement) => visit(statement, undefined));
  for (const fn of script.functions) walkNestedStatements(fn.body, (statement) => visit(statement, fn));
}
