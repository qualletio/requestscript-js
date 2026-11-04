import type { Script, Statement, StructDecl, StructRef, TypeNode } from './ast.js';
import { typeToString } from './types.js';

/**
 * How many structs deep a value's type may nest, counting the outermost: a struct whose field is a struct is
 * two deep. Lists don't count, but the structs in them do.
 */
export const MAX_STRUCT_DEPTH = 8;

/** A struct as the host knows it. Field types are type strings, as for resource functions and event types. */
export interface StructType {
  path: string;
  name: string;
  version: string;
  fields: { name: string; type: string }[];
}

export interface StructResolver {
  /** The struct `path.name` at exactly `version`, or undefined when the host doesn't know it. */
  resolve(path: string, name: string, version: string): Promise<StructType | undefined>;
}

/** `path.Name@version`. */
export function structLabel(ref: Pick<StructRef, 'path' | 'name' | 'version'>): string {
  return `${[...ref.path, ref.name].join('.')}@${ref.version}`;
}

/** A struct declaration as the host stores it and a `StructResolver` returns it. */
export function structType(declaration: StructDecl): StructType {
  return {
    path: declaration.path.join('.'),
    name: declaration.name,
    version: declaration.version,
    fields: declaration.fields.map((field) => ({ name: field.name, type: typeToString(field.type) })),
  };
}

/** A resolver over a fixed list of structs. */
export function createStructResolver(structs: StructType[]): StructResolver {
  const key = (path: string, name: string, version: string) => `${path ? `${path}.` : ''}${name}@${version}`;
  const map = new Map(structs.map((struct) => [key(struct.path, struct.name, struct.version), struct]));
  return {
    resolve: async (path, name, version) => map.get(key(path, name, version)),
  };
}

/** The structs a type names, directly or as a list's element. */
export function typeStructReferences(type: TypeNode): StructRef[] {
  return unique(collectType(type));
}

/**
 * Every struct a script names directly, once each, in source order: in its declaration's parameters, return
 * type or fields, and in its `var` and `const` types, including those in branches that may not run. It
 * doesn't include the structs those structs name, or the ones in the types of the resources and events the
 * script uses, which the host resolves when the script runs. A host checks them before it accepts the script.
 */
export function structReferences(script: Script): StructRef[] {
  const declaration = script.declaration;
  const types: TypeNode[] = [];
  switch (declaration.kind) {
    case 'contract':
      types.push(...declaration.parameters.map((parameter) => parameter.type));
      if (declaration.returnType) types.push(declaration.returnType);
      break;
    case 'event':
    case 'struct':
      types.push(...declaration.fields.map((field) => field.type));
      break;
    case 'request':
      break;
  }
  types.push(...statementTypes(script.body));
  return unique(types.flatMap(collectType));
}

function statementTypes(statements: Statement[]): TypeNode[] {
  return statements.flatMap((statement): TypeNode[] => {
    switch (statement.kind) {
      case 'varDecl':
        return statement.type ? [statement.type] : [];
      case 'if':
        return [
          ...statement.branches.flatMap((branch) => statementTypes(branch.body)),
          ...statementTypes(statement.elseBody ?? []),
        ];
      default:
        return [];
    }
  });
}

function collectType(type: TypeNode): StructRef[] {
  if (type.kind === 'list') return collectType(type.element);
  return type.kind === 'struct' ? [type] : [];
}

function unique(refs: StructRef[]): StructRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const label = structLabel(ref);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}
