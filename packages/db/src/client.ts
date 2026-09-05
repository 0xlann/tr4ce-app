import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase, type PostgresJsTransaction } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as cursorsSchema from "./schema/cursors.js";
import * as observationsSchema from "./schema/observations.js";
import * as rawSchema from "./schema/raw.js";
import * as registrySchema from "./schema/registry.js";

export const schema = {
  ...registrySchema,
  ...observationsSchema,
  ...cursorsSchema,
  ...rawSchema,
};

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
export type Transaction = PostgresJsTransaction<Schema, ExtractTablesWithRelations<Schema>>;
/**
 * Either handle. Every repository takes one of these rather than opening its own transaction, so
 * the caller decides the boundary — which is what lets promotion commit its rows and its cursor
 * together.
 */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  /** Closes the pool. Required in tests and one-shot workers, or the process will not exit. */
  close: () => Promise<void>;
}

/**
 * Open a connection pool.
 *
 * `numeric` and `int8` values arrive as strings from postgres.js and stay that way through
 * drizzle's `numeric` columns. That is deliberate: ERD section 9 forbids coercing them into
 * JavaScript numbers, where a uint256 token amount would lose precision silently.
 */
export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const client = postgres(url, {
    max: options.max ?? 5,
    // Prepared statements are pointless for a worker that runs a handful of distinct queries and
    // interfere with connection poolers.
    prepare: false,
  });

  const db = drizzle(client, { schema });

  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
