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
