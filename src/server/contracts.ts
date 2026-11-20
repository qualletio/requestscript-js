import { and, eq } from 'drizzle-orm';
import type { ContractDecl, Script } from '../lang/ast.js';
import { entrypoints } from '../lang/functions.js';
import { typeToString } from '../lang/types.js';
import { compareVersions } from '../lang/versions.js';
import { schema, type Database } from './db/index.js';
import type { ContractRow, StoredContractFunction } from './db/schema.js';

export interface SavedContract {
  path: string;
  name: string;
  version: string;
  functions: StoredContractFunction[];
  /** False when (path, name, version) already existed; contracts are immutable. */
  created: boolean;
}

/** A contract's entrypoints, with their type strings. */
export function declaredFunctions(script: Script): StoredContractFunction[] {
  return entrypoints(script).map((fn) => ({
    name: fn.name,
    parameters: fn.parameters.map((parameter) => ({ name: parameter.name, type: typeToString(parameter.type) })),
    returnType: fn.returnType ? typeToString(fn.returnType) : 'void',
    payable: fn.payable,
  }));
}

/**
 * Inserts the contract stored at (path, name, version). Contracts are
 * immutable: if that version already exists the row is left untouched and
 * `created` is false — save the contract again under a new version to change it.
 */
export async function saveContract(
  db: Database,
  script: Script & { declaration: ContractDecl },
  source: string,
): Promise<SavedContract> {
  const { declaration } = script;
  const path = declaration.path.join('.');
  const functions = declaredFunctions(script);

  const inserted = await db
    .insert(schema.contracts)
    .values({ path, name: declaration.name, version: declaration.version, source, functions })
    .onConflictDoNothing({ target: [schema.contracts.path, schema.contracts.name, schema.contracts.version] })
    .returning({ id: schema.contracts.id });

  return {
    path,
    name: declaration.name,
    version: declaration.version,
    functions,
    created: inserted.length > 0,
  };
}

/** Finds the given version of a contract, or the latest version when omitted. */
export async function findContract(
  db: Database,
  path: string,
  name: string,
  version?: string,
): Promise<ContractRow | undefined> {
  const key = and(eq(schema.contracts.path, path), eq(schema.contracts.name, name));
  if (version !== undefined) {
    const rows = await db
      .select()
      .from(schema.contracts)
      .where(and(key, eq(schema.contracts.version, version)))
      .limit(1);
    return rows[0];
  }
  // Versions order numerically per segment, which SQL text ordering gets
  // wrong ('1.9' > '1.10'), so the latest is picked in JS.
  const rows = await db.select().from(schema.contracts).where(key);
  return rows.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export async function listContracts(db: Database): Promise<ContractRow[]> {
  const rows = await db.select().from(schema.contracts);
  return rows.sort(
    (a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || compareVersions(a.version, b.version),
  );
}

/** Deletes the given version of a contract, or every version when omitted. */
export async function deleteContract(db: Database, path: string, name: string, version?: string): Promise<boolean> {
  const key = and(eq(schema.contracts.path, path), eq(schema.contracts.name, name));
  const deleted = await db
    .delete(schema.contracts)
    .where(version === undefined ? key : and(key, eq(schema.contracts.version, version)))
    .returning({ id: schema.contracts.id });
  return deleted.length > 0;
}
