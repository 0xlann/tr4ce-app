import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/**
 * Migration runner.
 *
 * Deliberately not `drizzle-kit generate`: the schema's composite foreign keys, partial unique
 * index, and canonicality trigger encode integrity rules a schema differ cannot infer, so the SQL
 * is hand-written and this only applies it. The drizzle table definitions are the query builder's
 * view of that SQL, not its source.
 *
 * Each file runs inside its own transaction and is recorded in `schema_migration`, so a re-run is
 * a no-op and a failed file leaves nothing half-applied.
 */

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(url: string): Promise<MigrationResult> {
  const client = postgres(url, { max: 1, prepare: false });

  try {
    // `IF NOT EXISTS` and `IF EXISTS` clauses raise a NOTICE on every no-op, which on a re-run
    // buries the one line that matters. Warnings and errors still come through.
    await client`SET client_min_messages = warning`;

    await client`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    const alreadyApplied = new Set(
      (await client<{ name: string }[]>`SELECT name FROM schema_migration`).map((row) => row.name),
    );

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      if (alreadyApplied.has(file)) {
        skipped.push(file);
        continue;
      }

      const sql = await readFile(join(migrationsDirectory, file), "utf8");

      // The simple query protocol is required: the file holds many statements and a dollar-quoted
      // plpgsql body, neither of which survives the extended protocol. The file opens and closes
      // its own transaction, so a failure rolls the whole file back.
      await client.unsafe(sql).simple();
      // Recorded after the fact. If the process dies between the two, the next run replays the
      // file — every statement in it is IF NOT EXISTS or CREATE OR REPLACE, so that is a no-op.
      await client`INSERT INTO schema_migration (name) VALUES (${file})`;

      applied.push(file);
    }

    return { applied, skipped };
  } finally {
    await client.end({ timeout: 5 });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url === "") {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }

  const result = await migrate(url);

  for (const name of result.applied) {
    console.log(`applied  ${name}`);
  }

  for (const name of result.skipped) {
    console.log(`skipped  ${name}`);
  }
}
