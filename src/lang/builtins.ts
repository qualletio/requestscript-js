import type { Expression, Script } from './ast.js';
import { walkExpressions } from './walk.js';

/**
 * What a script reads of the built-in variable `name`, in any of its statements, functions and lambdas,
 * including those that may not run: the properties it reads as `name.property`, in source order, and whether
 * it uses the variable whole in any other way (so it may read any property). A host checks these before it
 * accepts a script: a rendering's host asks a viewer to share only the `signIn` fields it reads.
 */
export function builtinReads(script: Script, name: string): { fields: string[]; whole: boolean } {
  const fields: string[] = [];
  let whole = false;
  const objects = new Set<Expression>();
  const visit = (expression: Expression): void => {
    if (expression.kind === 'member' && expression.object.kind === 'identifier' && expression.object.name === name) {
      objects.add(expression.object);
      if (!fields.includes(expression.property)) fields.push(expression.property);
    } else if (expression.kind === 'identifier' && expression.name === name && !objects.has(expression)) {
      whole = true;
    }
  };
  walkExpressions(script.body, visit);
  for (const fn of script.functions) walkExpressions(fn.body, visit);
  return { fields, whole };
}
