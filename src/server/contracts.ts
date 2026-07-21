import { and, eq } from 'drizzle-orm';
import type { ContractDecl } from '../lang/ast.js';
import { typeToString } from '../lang/types.js';
import { schema, type Database } from './db/index.js';
import type { ContractRow, StoredContractParameter } from './db/schema.js';

export interface SavedContract {
  path: string;
  name: string;
  parameters: StoredContractParameter[];
  created: boolean;
}

export function declaredParameters(declaration: ContractDecl): StoredContractParameter[] {
  return declaration.parameters.map((parameter) => ({
    name: parameter.name,
    type: typeToString(parameter.type),
  }));
}

/** Inserts or updates the contract stored at (path, name). */
export async function saveContract(
  db: Database,
  declaration: ContractDecl,
  source: string,
): Promise<SavedContract> {
  const path = declaration.path.join('.');
  const parameters = declaredParameters(declaration);

  const inserted = await db
    .insert(schema.contracts)
    .values({ path, name: declaration.name, source, parameters })
    .onConflictDoNothing({ target: [schema.contracts.path, schema.contracts.name] })
    .returning({ id: schema.contracts.id });

  const created = inserted.length > 0;
  if (!created) {
    await db
      .update(schema.contracts)
      .set({ source, parameters, updatedAt: new Date() })
      .where(and(eq(schema.contracts.path, path), eq(schema.contracts.name, declaration.name)));
  }
  return { path, name: declaration.name, parameters, created };
}

export async function findContract(db: Database, path: string, name: string): Promise<ContractRow | undefined> {
  const rows = await db
    .select()
    .from(schema.contracts)
    .where(and(eq(schema.contracts.path, path), eq(schema.contracts.name, name)))
    .limit(1);
  return rows[0];
}

export async function listContracts(db: Database): Promise<ContractRow[]> {
  return db.select().from(schema.contracts).orderBy(schema.contracts.path, schema.contracts.name);
}

export async function deleteContract(db: Database, path: string, name: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.contracts)
    .where(and(eq(schema.contracts.path, path), eq(schema.contracts.name, name)))
    .returning({ id: schema.contracts.id });
  return deleted.length > 0;
}
