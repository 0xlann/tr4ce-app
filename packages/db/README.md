# @tr4ce/db

Application schema, migrations, and repositories for confirmed vault observations.

## Two schemas, on purpose

The built-in PostgreSQL Database Changes sink owns the `raw_erc4626_*` staging tables, created from
`substreams/erc4626/schema.sql`. It inserts, updates, and **deletes** rows there while undoing
pre-confirmation reorgs. Nothing in the application ever references those rows.

Everything in `migrations/0001_registry_observations.sql` is the other side: registry, confirmed
observations, promotion cursor, and the minimal report identity a reorg has to be able to reach. It
carries the foreign keys, CHECK constraints, and composite integrity rules that raw staging cannot.

The promotion worker copies rows across that boundary, and only ever below the confirmed head. That
single bound is what makes the split work — a sink undo never has to fight a report's foreign key,
because a row the sink can still undo has never been promoted.

## Two cursors

| Table | Owner | Meaning |
|---|---|---|
| `cursors` | the sink | how far the sink has written into raw staging |
| `indexer_cursor` | this package | how far the worker has promoted into the application tables |

`promotionCeiling()` takes the lower of `sink head` and `rpcHead − network.confirmation_depth`.
Both bounds are load-bearing and neither implies the other: the confirmation depth alone would let
the worker scan blocks the sink has not written, and the sink head alone would let it promote rows
still inside the window where the sink may delete them.

## Invariants worth knowing before you change anything

- **NULL is not zero.** A failed read has no value. There is no `COALESCE` anywhere on the promotion
  path, and every snapshot amount column is nullable for this reason. A fabricated zero
  `total_assets` reads as a vault that lost every deposit.
- **Non-`ok` snapshots are promoted, not filtered.** A reverted read persists its classification so
  the dependent rule becomes `UNKNOWN`. Dropping the row would make missing evidence invisible.
- **Surrogate keys are derived, not random.** `src/ids.ts` hashes the row's natural key into a
  UUID v5, so a replay lands on the same primary key and "replay produces identical rows" is an
  assertion about the whole row rather than about everything except the id.
- **`canonical` is never in an upsert's `SET`.** Re-promoting a range must not resurrect an
  observation a deep reorg already marked orphaned.
- **Invalidation is append/audit state.** Orphaned rows are flipped to `canonical = false` and each
  invalidated subject gains a `reorg_invalidation` row recording both hashes. Nothing is deleted.
- **A rejected batch leaves the cursor exactly where it was.** Schema-version mismatch, unregistered
  vault, and unresolvable capability all throw before anything commits.

## What is tested here, and what is not

`observations.integration.test.ts` covers the promotion bound, replay idempotency, deep-reorg
invalidation, and the database-enforced integrity rules.

It does **not** test the sink's own undo. A Base reorg cannot be produced on demand, and the undo is
the sink's code, not ours. What is ours and fully testable is the bound: promotion never reads above
the confirmed head, so anything the sink is still entitled to undo never reaches these tables. The
test is named for that property rather than claiming coverage it does not have.

The deep-reorg tests synthesise the orphan. Everything after detection — the repository code path,
the constraints, the rows it runs against — is real.

## Running

```bash
docker compose up -d postgres
pnpm --filter @tr4ce/db build
pnpm --filter @tr4ce/db migrate

# Integration tests, across the whole workspace.
TR4CE_TEST_DATABASE_URL=postgres://tr4ce:tr4ce@localhost:5432/tr4ce_test pnpm test
```

The URL is a naming base, not a database that has to exist: each suite provisions
`<name>_<suite>` for itself (`tr4ce_test_observations`, `tr4ce_test_worker`). Turbo runs package
tasks in parallel, and two suites rebuilding one schema would tear it down under each other.

Without `TR4CE_TEST_DATABASE_URL` the integration suites skip and only the pure tests run, so
`pnpm test` stays green with no container. The variable is declared in `turbo.json`'s `test` task
so it is part of the cache key — otherwise a cached run from a machine without a database would be
replayed as a pass.

Note the DSN scheme difference: the sink CLI rejects `postgresql://` and accepts only `psql://` or
`postgres://`, so `SUBSTREAMS_SINK_DSN` is kept separate from `DATABASE_URL`.

## Deploying to a hosted database

The application talks plain PostgreSQL through `DATABASE_URL` and contains no provider-specific
code, so the target is a configuration choice rather than an architectural one. Supabase is what
these instructions assume; anything that speaks PostgreSQL 15+ works the same way.

Local PostgreSQL stays. It is not a fallback — it is where development and the integration suites
run, and `provisionTestDatabase` refuses a hosted hostname because its first act is
`DROP DATABASE ... WITH (FORCE)`. Measured on one Linux machine: 0.667 ms per round trip locally
against roughly 25 ms to Supabase's Singapore region, across 134 integration tests.

```bash
# 1. Schema. The same migration runner, pointed at the hosted database.
DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @tr4ce/db migrate

# 2. Data. Data only — the schema was just built by step 1, and a dump carrying DDL would let the
#    two databases drift while looking identical.
./scripts/copy-to-supabase.sh

# 3. After the sink's first run against that database, if it ever runs there. The sink creates
#    `cursors` and `substreams_history` itself, after migrations, so migration 0003 never saw them.
DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @tr4ce/db enable-rls
```

### Row-level security is not optional here

Supabase publishes every table in `public` through PostgREST, reachable with the anon key — a value
that is public by design and shipped in the frontend bundle. A table there without row-level
security is readable, and usually writable, by anyone who opens the network tab.

Migration 0003 enables RLS on every table and defines no policy, which denies everything. The roles
that own the tables are unaffected: PostgreSQL exempts a table's owner from RLS unless
`FORCE ROW LEVEL SECURITY` is set, which it deliberately is not. `rls.integration.test.ts` fails if
any table is left uncovered, and asserts the owner exemption is still in place — without it the API
and the worker would read empty tables and write nothing.

### What still needs a host that stays running

The Substreams sink is a streaming consumer holding a cursor; it cannot run on a serverless
platform. For a demo it does not need to: run it locally until the database is populated, copy the
result up, and deploy the API and web against the hosted database. Continuous indexing needs an
always-on host — and once that host exists, PostgreSQL on it is both cheaper and far faster for the
sink and worker, which are the chattiest consumers. `pg_dump | psql` moves between the two.

### Free tier

A free Supabase project pauses after 7 days without activity, and a paused project is an offline
demo. Either keep something touching it on a schedule, or move to a paid plan before any window
where the demo has to work unattended.
