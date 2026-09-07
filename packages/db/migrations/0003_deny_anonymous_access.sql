-- Close the door PostgREST opens.
--
-- Supabase publishes every table in the `public` schema through PostgREST, reachable with the anon
-- key — which is a *public* value, embedded in the frontend bundle by design. A table there with
-- row-level security switched off is readable, and usually writable, by anyone who loads the site
-- and opens the network tab.
--
-- Most of what TR4CE stores is public chain data, so a leak would be dull. Two tables are not:
-- `wallet` holds the addresses people attach policies to, and `policy` / `policy_version` hold the
-- thresholds they judge vaults by. Neither is ours to publish. Reads are only half of it — without
-- RLS an anonymous writer could insert an `evidence_report` row, and a fabricated report inside a
-- product whose whole claim is verifiable evidence is the worst outcome on offer.
--
-- Enabling RLS with no policy denies everything, because no policy means no row matches. The roles
-- that own these tables keep full access: PostgreSQL exempts a table's owner from RLS unless
-- FORCE ROW LEVEL SECURITY is set, which it deliberately is not. That is what leaves the API, the
-- promotion worker, and the sink working unchanged while PostgREST sees nothing.
--
-- Applied to local PostgreSQL as well, not only to Supabase. A rule that holds in one environment
-- only is a rule nobody tests; here the local suite exercises it on every run.
--
-- Scope, stated honestly: this covers the tables that exist when it runs. The sink creates
-- `cursors` and `substreams_history` itself, on first run, which is usually *after* migrations —
-- so those two are not covered by this file. `scripts/enable-rls.mjs` re-applies the same rule and
-- is safe to run at any time; the deployment checklist in packages/db/README.md runs it after the
-- sink's first start. `rls.integration.test.ts` fails if any table is left uncovered, so the gap
-- is caught rather than assumed away.

BEGIN;

DO $$
DECLARE
    target TEXT;
BEGIN
    FOR target IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    END LOOP;
END
$$;

COMMIT;
