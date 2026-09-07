/**
 * Enable row-level security on every table in `public`.
 *
 * The same rule as migration 0003, in a form that can be re-run. Migrations run once, but the
 * Substreams sink creates `cursors` and `substreams_history` on its own first start — usually
 * after migrations — so those two would otherwise stay exposed through PostgREST.
 *
 * Idempotent: enabling RLS on a table that already has it is a no-op. Run it after the sink's
 * first start, and again whenever anything creates a table outside the migration runner.
 *
 *   DATABASE_URL=<url> node scripts/enable-rls.mjs
 */

import postgres from "postgres";

const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  const exposed = await sql`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  `;

  if (exposed.length === 0) {
    console.log("Every table in public already has row-level security enabled.");
  } else {
    for (const { name } of exposed) {
      await sql.unsafe(`ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY`);
      console.log(`enabled  ${name}`);
    }

    console.log(`\n${exposed.length} table(s) secured.`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
