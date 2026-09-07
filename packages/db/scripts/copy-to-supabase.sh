#!/usr/bin/env bash
#
# Copy the local database into a hosted one.
#
# Data only. The schema is built by the migration runner on both sides, so this never carries DDL:
# a dump that recreated tables would let the two databases drift apart while looking identical, and
# `schema_migration` would then disagree with what is actually there.
#
# Deliberately not `--clean`. Overwriting a deployed database is a decision, not a default; if the
# target already holds rows this fails on conflicts and says so, and you decide what to do.
#
#   DATABASE_URL=<local> SUPABASE_DATABASE_URL=<remote> ./scripts/copy-to-supabase.sh
#
# Run the migrations against the target first:
#   DATABASE_URL=$SUPABASE_DATABASE_URL pnpm --filter @tr4ce/db migrate

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL (source) is required}"
: "${SUPABASE_DATABASE_URL:?SUPABASE_DATABASE_URL (target) is required}"

# `--disable-triggers` is about one trigger in particular: report_observation_canonical_trigger
# refuses a citation whose observation is not canonical, and a data-only restore has no control
# over table order — report_observation rows can land before the vault_snapshot rows they cite.
# Turning it off for the restore is safe because every row being copied already passed that check
# when it was first written. It is not a way around the rule; it is not re-asking a settled
# question.
echo "Dumping data from the local database..."

pg_dump "$DATABASE_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --disable-triggers \
  --exclude-table=schema_migration \
  > /tmp/tr4ce-data.sql

echo "Dumped $(wc -l < /tmp/tr4ce-data.sql) lines."
echo "Restoring into the target..."

# ON_ERROR_STOP so a failed statement aborts instead of leaving a half-copied database that looks
# populated. `--single-transaction` makes the whole restore all-or-nothing.
psql "$SUPABASE_DATABASE_URL" \
  --single-transaction \
  --variable ON_ERROR_STOP=1 \
  --quiet \
  --file /tmp/tr4ce-data.sql

rm -f /tmp/tr4ce-data.sql

echo
echo "Done. Verifying row counts on the target:"
psql "$SUPABASE_DATABASE_URL" --quiet --tuples-only --no-align --command "
  SELECT relname || ' = ' || n_live_tup
  FROM pg_stat_user_tables
  WHERE n_live_tup > 0
  ORDER BY n_live_tup DESC"
