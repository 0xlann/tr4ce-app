#!/usr/bin/env bash
#
# Live verification against Base mainnet at pinned blocks.
#
# The substreams CLI ships a `--test-file` flag, but in v1.22.0 it is inert: a deliberately wrong
# expectation still reports "Completed successfully" with exit 0. These checks therefore run the
# module and assert on its real output with jq, so a regression actually fails the build.
#
# Requires: substreams CLI, jq, and SUBSTREAMS_API_TOKEN in the environment.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${SUBSTREAMS_API_TOKEN:?SUBSTREAMS_API_TOKEN must be set}"
ENDPOINT=${GRAPH_SUBSTREAMS_ENDPOINT:-base-mainnet.streamingfast.io:443}

ANCHOR_BLOCK=50577041   # declared window start; every curated vault is snapshotted here
DEPOSIT_BLOCK=50878912  # a real Deposit into Gauntlet USDC Prime
GT_USDCP=0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61

pass=0; fail=0
check() { # name expected actual
  if [[ $2 == "$3" ]]; then
    printf '  ok    %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL  %s: expected %s, got %s\n' "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}

# jsonl output wraps each block in an envelope; the batch itself lives under "@data".
run_block() {
  substreams run -e "$ENDPOINT" substreams.yaml map_vault_block_batch \
    --start-block "$1" --stop-block +1 -o jsonl 2>/dev/null | jq -s '.[0]["@data"]'
}

echo "Window anchor block $ANCHOR_BLOCK"
ANCHOR=$(run_block "$ANCHOR_BLOCK")

# Every curated vault is observed at the window start, so a start observation always exists.
check "snapshots every curated vault" 4 \
  "$(jq '.snapshots | length' <<<"$ANCHOR")"
check "every read succeeded" 0 \
  "$(jq '[.snapshots[] | select(.callStatus != "CALL_STATUS_OK")] | length' <<<"$ANCHOR")"
check "all tagged as window anchor" 4 \
  "$(jq '[.snapshots[] | select(.trigger.windowAnchor == true)] | length' <<<"$ANCHOR")"
# An absent value must serialise empty, never as a fabricated zero.
check "no snapshot reports an empty totalAssets" 0 \
  "$(jq '[.snapshots[] | select(.totalAssets == "")] | length' <<<"$ANCHOR")"
check "no flows on this block" 0 \
  "$(jq '(.deposits // []) + (.withdrawals // []) | length' <<<"$ANCHOR")"

echo "Activity block $DEPOSIT_BLOCK"
ACTIVITY=$(run_block "$DEPOSIT_BLOCK")

check "one deposit decoded" 1 \
  "$(jq '.deposits | length' <<<"$ACTIVITY")"
check "deposit attributed to the curated vault" "$GT_USDCP" \
  "$(jq -r '.deposits[0].vault' <<<"$ACTIVITY")"
# The share mint is classified rather than dropped, so the evidence engine can prove it excluded
# it from economic flow instead of never having seen it.
check "accompanying share mint classified" 1 \
  "$(jq '[.shareTransfers[] | select(.kind == "TRANSFER_KIND_MINT")] | length' <<<"$ACTIVITY")"
# Only the vault that actually moved assets is snapshotted; the other three are left alone.
check "only the active vault is snapshotted" 1 \
  "$(jq '.snapshots | length' <<<"$ACTIVITY")"
check "snapshot tagged as activity" "true" \
  "$(jq -r '.snapshots[0].trigger.activity' <<<"$ACTIVITY")"

echo "Golden fixtures"
for spec in "$ANCHOR_BLOCK:golden_${ANCHOR_BLOCK}_anchor.jsonl" \
            "$DEPOSIT_BLOCK:golden_${DEPOSIT_BLOCK}_deposit.jsonl"; do
  block=${spec%%:*}; file=tests/fixtures/${spec##*:}
  fresh=$(substreams run -e "$ENDPOINT" substreams.yaml map_vault_block_batch \
    --start-block "$block" --stop-block +1 -o jsonl 2>/dev/null | jq -S -c '.')
  if diff -q <(printf '%s\n' "$fresh") "$file" >/dev/null; then
    check "matches $(basename "$file")" ok ok
  else
    check "matches $(basename "$file")" ok differs
  fi
done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
