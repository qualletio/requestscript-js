import { and, eq } from 'drizzle-orm';
import type { ContractDecl } from '../lang/ast.js';
import { typeToString } from '../lang/types.js';
import { schema, type Database } from './db/index.js';
import type { ContractRow, StoredContractParameter } from './db/schema.js';

export interface SavedContract {
  path: string;
  name: string;
  version: string;
  parameters: StoredContractParameter[];
  /** False when (path, name, version) already existed; contracts are immutable. */
  created: boolean;
}

/**
 * Orders versions numerically per dot-separated segment ('1.10' > '1.9');
 * missing segments count as 0, with the raw string as a final tie-break
 * so that e.g. '1' and '1.0' order deterministically.
 */
export function compareVersions(a: string, b: string): number {
  const aSegments = a.split('.');
  const bSegments = b.split('.');
  for (let i = 0; i < Math.max(aSegments.length, bSegments.length); i++) {
    const aValue = BigInt(aSegments[i] ?? '0');
    const bValue = BigInt(bSegments[i] ?? '0');
    if (aValue !== bValue) return aValue < bValue ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function declaredParameters(declaration: ContractDecl): StoredContractParameter[] {
  return declaration.parameters.map((parameter) => ({
    name: parameter.name,
    type: typeToString(parameter.type),
  }));
}

/**
 * Inserts the contract stored at (path, name, version). Contracts are
 * immutable: if that version already exists the row is left untouched and
 * `created` is false — save the contract again under a new version to change it.
 */
export async function saveContract(
  db: Database,
  declaration: ContractDecl,
  source: string,
): Promise<SavedContract> {
  const path = declaration.path.join('.');
  const parameters = declaredParameters(declaration);

  const inserted = await db
    .insert(schema.contracts)
    .values({ path, name: declaration.name, version: declaration.version, source, parameters })
    .onConflictDoNothing({ target: [schema.contracts.path, schema.contracts.name, schema.contracts.version] })
    .returning({ id: schema.contracts.id });

  return {
    path,
    name: declaration.name,
    version: declaration.version,
    parameters,
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
