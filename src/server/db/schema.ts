import { jsonb, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export interface StoredContractParameter {
  name: string;
  /** Requestscript type string, e.g. 'int32' or '[]string'. */
  type: string;
}

/**
 * Saved contracts. A contract is identified by (path, name, version) and is
 * immutable: changing one means saving it again under a new version.
 */
export const contracts = pgTable(
  'contracts',
  {
    id: serial('id').primaryKey(),
    /** Dotted path such as 'path.to'; empty string for a path-less contract. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    /** Version declared in the contract source — dot-separated numbers such as '2' or '1.2.3'; '1' when not declared. */
    version: text('version').notNull().default('1'),
    /** Full Requestscript source of the contract. */
    source: text('source').notNull(),
    /** Declared parameters, denormalized for listing and validation. */
    parameters: jsonb('parameters').notNull().$type<StoredContractParameter[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('contracts_path_name_version_unique').on(table.path, table.name, table.version)],
);

export type ContractRow = typeof contracts.$inferSelect;
