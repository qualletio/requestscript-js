import { jsonb, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export interface StoredContractParameter {
  name: string;
  /** Requestscript type string, e.g. 'int32' or '[]string'. */
  type: string;
}

/**
 * Saved contracts. Two contracts may share a name, but only one contract can
 * exist at a given path with that name (enforced by the unique index).
 */
export const contracts = pgTable(
  'contracts',
  {
    id: serial('id').primaryKey(),
    /** Dotted path such as 'path.to'; empty string for a path-less contract. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    /** Full Requestscript source of the contract. */
    source: text('source').notNull(),
    /** Declared parameters, denormalized for listing and validation. */
    parameters: jsonb('parameters').notNull().$type<StoredContractParameter[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('contracts_path_name_unique').on(table.path, table.name)],
);

export type ContractRow = typeof contracts.$inferSelect;
