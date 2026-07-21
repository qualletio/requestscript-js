import { interpret, type InterpretOptions } from '../src/lang/interpreter.js';

/** Runs a script and returns its JSON-encoded return value. */
export async function run(source: string, options: InterpretOptions = {}): Promise<unknown> {
  const result = await interpret(source, options);
  return result.returnValue;
}

/** Wraps a script body in a request declaration and runs it. */
export async function runBody(body: string, options: InterpretOptions = {}): Promise<unknown> {
  return run(`request Test {\n${body}\n}`, options);
}
