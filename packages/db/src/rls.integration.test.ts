import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "./client.js";
import { migrate } from "./migrate.js";
import { provisionTestDatabase } from "./testing.js";

/**
 * Row-level security coverage.
 *
 * Supabase publishes the `public` schema through PostgREST using the anon key, which is a public
 * value by design. A table there without RLS is readable and usually writable by anyone who loads
 * the site. Migration 0003 closes that, and this asserts it stayed closed: a table added by a later
 * migration inherits nothing, so without this check the first uncovered table would ship silently.
 *
 * Run against local PostgreSQL like every other integration suite. The rule is applied locally as
 * well as on Supabase precisely so it can be tested here rather than only in production.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

describe.skipIf(url === undefined)("row-level security", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;

  beforeAll(async () => {
    const databaseUrl = await provisionTestDatabase(url!, "rls");

    handle = createDatabase(databaseUrl, { max: 2 });
    db = handle.db;

    // The sink's staging tables first, so they are present when 0003 sweeps the schema — they are
    // as exposed as anything else, and a rewritten raw row would corrupt promotion at the source.
    await db.execute(
      sql.raw(
        readFileSync(join(here, "..", "..", "..", "substreams", "erc4626", "schema.sql"), "utf8"),
      ),
    );

    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await handle?.close();
  });

  const unprotected = async () =>
    (
      await db.execute<{ name: string }>(sql`
        SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY c.relname
      `)
    ).map((row) => row.name);

  it("leaves no table in public without row-level security", async () => {
    // Named in the failure rather than counted, so the message says which table to fix.
    expect(await unprotected()).toEqual([]);
  });

  it("covers the tables that actually hold user data", async () => {
    /*
     * The rest of the schema is public chain data; these three are not. `wallet` holds the
     * addresses people attach policies to, and the policy tables hold the thresholds they judge
     * vaults by. Asserted by name so a future migration cannot quietly drop and recreate one
     * without RLS and still pass the sweep above on a technicality.
     */
    const rows = await db.execute<{ name: string; enabled: boolean }>(sql`
      SELECT c.relname AS name, c.relrowsecurity AS enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('wallet', 'policy', 'policy_version')
    `);

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.enabled)).toBe(true);
  });

  it("does not force RLS on the owner, or the application would lock itself out", async () => {
    /*
     * The distinction the whole design rests on. `relforcerowsecurity` would apply the policies to
     * the table's owner too — and with no policies defined, that means the API, the promotion
     * worker and the sink would all read empty tables and write nothing.
     *
     * Deny-everything works here only because PostgreSQL exempts the owner by default.
     */
    const forced = await db.execute<{ name: string }>(sql`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
    `);

    expect(forced.map((row) => row.name)).toEqual([]);
  });

  it("still lets the owner read and write every table", async () => {
    // The proof that matters: RLS is on, and the connection the application uses is unaffected.
    await db.execute(sql`
      INSERT INTO network (chain_id, slug, name, native_symbol, confirmation_depth)
      VALUES (8453, 'base', 'Base', 'ETH', 64)
    `);

    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM network`,
    );

    expect(rows[0]!.count).toBe("1");
  });
});
