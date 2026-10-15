/**
 * Resources let Requestscript call functions implemented in the host
 * language (TypeScript). Hosts declare resources and pass them to the
 * interpreter; scripts bind them with `const ref: path.to.ResourceName`
 * and call `ref.functionName(arg: value, ...)`.
 */

export interface ResourceFunctionParameter {
  name: string;
  /** A Requestscript type string, e.g. 'int32' or '[]string'. */
  type: string;
}

export interface ResourceFunctionCallParameter {
  name: string;
  value: unknown;
}

export interface ResourceFunction {
  name: string;
  parameters: ResourceFunctionParameter[];
  exec: (args: ResourceFunctionCallParameter[]) => Promise<unknown>;
  /** A Requestscript type string, or 'void' when nothing is returned. */
  returnType: string;
}

export interface Resource {
  metadata: Record<string, unknown>;
  /** Dotted path such as 'path.to'. */
  path: string;
  name: string;
  functions: ResourceFunction[];
}

/** The failure reported by a resource call, surfaced to scripts as `result.error`. */
export interface ResourceError {
  message: string;
}

/**
 * The outcome of a resource call. Scripts always see a call as an object with
 * `value` and `error` properties, so they can branch on `result.error != null`
 * instead of failing the whole script.
 */
export interface ResourceResult {
  value: unknown;
  error: ResourceError | null;
}

/** A successful result; `value` is omitted for void functions. */
export function resourceValue(value: unknown = null): ResourceResult {
  return { value, error: null };
}

/** A failed result. The message is what the script reads as `result.error.message`. */
export function resourceError(message: string): ResourceResult {
  return { value: null, error: { message } };
}

/** The fully qualified name used to look a resource up. */
export function resourceKey(path: string, name: string): string {
  return `${path}.${name}`;
}
