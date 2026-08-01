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
  exec: (args: ResourceFunctionCallParameter[]) => unknown;
  /** A Requestscript type string, or 'void' when nothing is returned. */
  returnType: string;
}

export interface Resource {
  /** Dotted path such as 'path.to'. */
  path: string;
  name: string;
  functions: ResourceFunction[];
}

/** The fully qualified name used to look a resource up. */
export function resourceKey(path: string, name: string): string {
  return `${path}.${name}`;
}
