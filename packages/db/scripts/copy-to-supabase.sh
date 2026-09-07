#!/usr/bin/env bash
#
# Copy the local database into a hosted one.
#
# Data only. The schema is built by the migration runner on both sides, so this never carries DDL:
# a dump that recreated tables would let the two databases drift apart while looking identical, and
# `schema_migration` would then disagree with what is actually there.
#
# Three tables are left behind. `schema_migration` is written by the runner on the target. `cursors`
# and `substreams_history` belong to the Substreams sink, which creates them itself on first run and
# does not run against the hosted database in this topology — the sink and the promotion worker stay
# on local PostgreSQL, and only `readSinkHead` in the worker ever reads them. Copying a sink cursor
# to a database no sink is streaming into would be a stale claim about how far indexing had reached.
#
# Deliberately not `--clean`. Overwriting a deployed database is a decision, not a default; if the
# target already holds rows this fails on conflicts and says so, and you decide what to do.
#
#   DATABASE_URL=<local> SUPABASE_SESSION_POOLER=<remote> ./scripts/copy-to-supabase.sh
#
# `pg_dump` and `psql` are used from the local Docker container when they are not on PATH, so this
# needs no postgresql-client package installed on the host. The container's client is one major
# version behind the hosted server, which is the supported direction: a client may talk to a newer
# server, and the dump itself is produced against the local server it matches exactly.
#
# Run the migrations against the target first:
#   DATABASE_URL=$SUPABASE_SESSION_POOLER pnpm --filter @tr4ce/db migrate

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL (source) is required}"
: "${SUPABASE_SESSION_POOLER:?SUPABASE_SESSION_POOLER (target) is required}"

# Prefer a client on PATH; fall back to the one inside the compose container. Both are named so a
# failure says which was used rather than leaving you to guess.
#
# Tested by running it, not by `command -v`. Debian and Ubuntu install a `pg_wrapper` shim at
# /usr/bin/pg_dump whether or not any client version is present, so the path exists and the binary
# then fails with "You must install at least one postgresql-client-<version> package".
if pg_dump --version >/dev/null 2>&1 && psql --version >/dev/null 2>&1; then
  run_dump() { pg_dump "$@"; }
  run_psql() { psql "$@"; }
  echo "Using the postgresql-client on PATH."
else
  run_dump() { docker compose exec -T postgres pg_dump "$@"; }
  run_psql() { docker compose exec -T postgres psql "$@"; }
  echo "No postgresql-client on PATH; using the one inside the compose container."
fi

# A data-only dump writes tables in alphabetical order, which is not dependency order: `asset`
# references `network` and sorts before it. Two things therefore have to stand down during the
# restore — the foreign keys, and report_observation_canonical_trigger, which refuses a citation
# whose observation is not canonical and would fire before the snapshot rows it checks have landed.
#
# `SET session_replication_role = replica` does both for the session. pg_dump's own
# `--disable-triggers` cannot: it emits `ALTER TABLE ... DISABLE TRIGGER ALL`, and turning off the
# system triggers behind a foreign key needs superuser, which a hosted database will not give you.
#
# Safe because every row being copied already satisfied both rules when it was first written. This
# is not a way around them; it is not re-asking a settled question.
# `substreams_history_id_seq` is named on its own: a sequence is a separate object, so excluding its
# table still leaves the setval() for it in the dump, pointing at a relation the target never had.
echo "Dumping data from the local database..."

run_dump "$DATABASE_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --exclude-table=schema_migration \
  --exclude-table=cursors \
  --exclude-table=substreams_history \
  --exclude-table=substreams_history_id_seq \
  > /tmp/tr4ce-data.sql

echo "Dumped $(wc -l < /tmp/tr4ce-data.sql) lines."
echo "Restoring into the target..."

# ON_ERROR_STOP so a failed statement aborts instead of leaving a half-copied database that looks
# populated. `--single-transaction` makes the whole restore all-or-nothing.
{
  echo "SET session_replication_role = replica;"
  cat /tmp/tr4ce-data.sql
} | run_psql "$SUPABASE_SESSION_POOLER" \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --quiet

rm -f /tmp/tr4ce-data.sql

echo
echo "Done. Verifying row counts on the target:"
run_psql "$SUPABASE_SESSION_POOLER" --quiet --tuples-only --no-align --command "
  SELECT relname || ' = ' || n_live_tup
  FROM pg_stat_user_tables
  WHERE schemaname = 'public' AND n_live_tup > 0
  ORDER BY n_live_tup DESC"
