/**
 * Error hierarchy for Requestscript.
 *
 * All errors thrown while lexing, parsing, or interpreting a script are
 * subclasses of RequestScriptError so hosts can catch script problems
 * without swallowing genuine host bugs.
 */
export class RequestScriptError extends Error {
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(message: string, line?: number, column?: number) {
    super(line !== undefined ? `${message} (line ${line})` : message);
    this.name = new.target.name;
    this.line = line;
    this.column = column;
  }
}

/** A problem found while tokenizing source text. */
export class LexError extends RequestScriptError {}

/** A problem found while parsing tokens into a syntax tree. */
export class ParseError extends RequestScriptError {}

/** A problem found while executing a script. */
export class RuntimeError extends RequestScriptError {}

/** Invalid parameters supplied when invoking a contract. */
export class ParameterError extends RuntimeError {}
