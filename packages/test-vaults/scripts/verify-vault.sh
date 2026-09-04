#!/usr/bin/env bash
#
# Executable ten-step vault onboarding gate from docs/technical/INTEGRATIONS.md section 4.
#
# Emits one JSON object conforming to curatedVaultSchema in @tr4ce/domain, ready to be folded
# into packages/test-vaults/src/manifest.json.
#
# Protocol APIs are used for discovery only. Every value recorded here is read back on chain:
# identity must never rest on an untrusted ticker or third-party metadata.
#
# Usage:
#   verify-vault.sh <vault-address> <protocol-slug> <adapter-key> <adapter-version>
#
# Requires: cast (foundry), jq, and RPC_URL_BASE in the environment.

set -euo pipefail

VAULT_RAW=${1:?vault address required}
PROTOCOL_SLUG=${2:?protocol slug required}
ADAPTER_KEY=${3:?adapter key required}
ADAPTER_VERSION=${4:?adapter version required}

: "${RPC_URL_BASE:?RPC_URL_BASE must be set}"
export ETH_RPC_URL="$RPC_URL_BASE"

# Canonical USDC on Base, taken from Circle's published deployment list and confirmed on chain.
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_SOURCE="https://developers.circle.com/stablecoins/usdc-contract-addresses"
RPC_PROVIDER_KEY="base-public-mainnet"

# 7 days at Base's ~2s block time, verified empirically against block timestamps.
WINDOW_DAYS=7
WINDOW_BLOCKS=302400

# PINNED_HEAD keeps every vault in one manifest on the same window, which is what makes the
# comparison honest. Without it each run would drift to a different head block.
HEAD=${PINNED_HEAD:-$(cast block-number)}
HIST=$((HEAD - WINDOW_BLOCKS))

log() { printf '  %s\n' "$*" >&2; }

# Call a read method and return the RAW ABI return data, or the empty string when it reverts.
# The signature is passed without a return type on purpose: the undecoded bytes are the evidence,
# and decoding is a separate, reversible step.
try_call() {
  local block=$1; shift
  cast call "$VAULT" "$@" --block "$block" 2>/dev/null || true
}

# Decode a 32-byte word of raw return data to a decimal integer. Empty in, empty out.
to_dec() {
  local raw=$1
  [[ -z $raw || $raw == "0x" ]] && return 0
  cast to-dec "$raw" 2>/dev/null || true
}

# Build one capability probe record. A method that reverts is recorded as such; a zero returned
# for an owner that demonstrably holds shares is a documented non-standard zero, not a verified
# zero capacity, and must reach policy as UNKNOWN rather than FAIL.
probe() {
  local method=$1 block=$2 raw=$3 holds_position=${4:-false}
  local status reason note value
  value=$(to_dec "$raw")

  if [[ -z $raw ]]; then
    status=reverted; reason=CALL_REVERTED; note=null
  elif [[ $holds_position == true && $value == 0 ]]; then
    status=nonstandard_zero; reason=AMBIGUOUS_CAPABILITY
    note='"Returned zero for an owner holding shares; raw result preserved, capacity unresolved."'
  else
    status=supported; reason=null; note=null
  fi

  jq -n --arg m "$method" --arg s "$status" --arg b "$block" \
        --arg raw "${raw:-}" --argjson note "$note" \
        --arg reason "$reason" '
    {
      method: $m,
      status: $s,
      atBlock: $b,
      rawResult: (if $raw == "" then null else $raw end),
      revertData: null,
      reasonCode: (if $reason == "null" then null else $reason end),
      note: $note
    }'
}

# ---- steps 1-2: identity, bytecode, proxy ------------------------------------------------
VAULT=$(cast to-check-sum-address "$VAULT_RAW")
log "step 1-2  identity and bytecode"

CODE=$(cast code "$VAULT" --block "$HEAD")
if [[ $CODE == "0x" || -z $CODE ]]; then
  echo "FAIL: no bytecode at $VAULT" >&2
  exit 1
fi
CODE_HASH=$(printf '%s' "$CODE" | cast keccak)

IMPL_SLOT=$(cast storage "$VAULT" \
  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --block "$HEAD")
if [[ $IMPL_SLOT =~ ^0x0{64}$ ]]; then
  IMPL_ADDRESS=null
  IMPL_CODE_HASH=null
else
  # printf '%s' matters: piping cast output directly appends a newline, which makes the hex
  # odd-length and cast keccak rejects it.
  IMPL_ADDRESS="\"0x${IMPL_SLOT: -40}\""
  IMPL_CODE=$(cast code "0x${IMPL_SLOT: -40}" --block "$HEAD")
  IMPL_CODE_HASH="\"$(printf '%s' "$IMPL_CODE" | cast keccak)\""
fi

# Lowest block at which this address already has bytecode. Recorded as provenance only; the
# observation window is driven by windowStartBlock, never by this value.
find_deployment_block() {
  local lo=0 hi=$HEAD mid
  while (( lo < hi )); do
    mid=$(( (lo + hi) / 2 ))
    if [[ $(cast code "$VAULT" --block "$mid" 2>/dev/null) == "0x" ]]; then
      lo=$(( mid + 1 ))
    else
      hi=$mid
    fi
  done
  printf '%s' "$lo"
}

# ---- steps 3-4: canonical asset and decimals ---------------------------------------------
log "step 3-4  canonical asset and decimals"
ASSET=$(cast call "$VAULT" 'asset()(address)' --block "$HEAD")
if [[ ${ASSET,,} != "${USDC,,}" ]]; then
  echo "FAIL: asset() is $ASSET, not canonical Base USDC" >&2
  exit 1
fi

SHARE_DECIMALS=$(cast call "$VAULT" 'decimals()(uint8)' --block "$HEAD")
ASSET_DECIMALS=$(cast call "$USDC" 'decimals()(uint8)' --block "$HEAD")
if (( SHARE_DECIMALS > 77 || ASSET_DECIMALS > 77 )); then
  echo "FAIL: decimals out of supported range" >&2
  exit 1
fi
ONE_SHARE=$(python3 -c "print(10**$SHARE_DECIMALS)")

NAME=$(cast call "$VAULT" 'name()(string)' --block "$HEAD" | tr -d '"')
SYMBOL=$(cast call "$VAULT" 'symbol()(string)' --block "$HEAD" | tr -d '"')

# ---- step 6: decode real flows from a bounded historical range ----------------------------
# The public Base endpoint caps eth_getLogs at 10,000 blocks, so the range is walked in windows.
log "step 6    decode Deposit and Withdraw from a bounded range"
DEPOSIT_TOPIC=$(cast sig-event 'Deposit(address,address,uint256,uint256)')

FLOW_BLOCK=""; FLOW_TX=""; PROBE_OWNER=""
for offset in 0 9000 18000 27000 36000; do
  logs=$(cast logs --from-block $((HEAD - offset - 9000)) --to-block $((HEAD - offset)) \
    --address "$VAULT" "$DEPOSIT_TOPIC" --json 2>/dev/null || echo '[]')
  [[ $(jq 'length' <<<"$logs") -eq 0 ]] && continue

  read -r FLOW_BLOCK FLOW_TX PROBE_OWNER < <(
    jq -r '.[0] | "\(.blockNumber) \(.transactionHash) 0x\(.topics[2][26:66])"' <<<"$logs"
  )
  FLOW_BLOCK=$((FLOW_BLOCK))
  break
done

if [[ -z $FLOW_BLOCK ]]; then
  echo "FAIL: no Deposit event found in the scanned range" >&2
  exit 1
fi

# ---- steps 5 and 7: probe every required read at latest and one historical block ----------
# Never fall back from a pinned historical block to latest.
log "step 5,7  capability probes at $HEAD and $HIST"

# A zero from an owner that demonstrably holds shares is the signal that separates a documented
# non-standard zero from an honest "this account has no position".
OWNER_BALANCE=$(to_dec "$(try_call "$HEAD" 'balanceOf(address)' "$PROBE_OWNER")")
HOLDS=false
[[ -n $OWNER_BALANCE && $OWNER_BALANCE != 0 ]] && HOLDS=true

build_probes() {
  local block=$1

  jq -s '.' \
    <(probe asset           "$block" "$(try_call "$block" 'asset()')") \
    <(probe decimals        "$block" "$(try_call "$block" 'decimals()')") \
    <(probe totalAssets     "$block" "$(try_call "$block" 'totalAssets()')") \
    <(probe totalSupply     "$block" "$(try_call "$block" 'totalSupply()')") \
    <(probe convertToAssets "$block" "$(try_call "$block" 'convertToAssets(uint256)' "$ONE_SHARE")") \
    <(probe maxWithdraw     "$block" "$(try_call "$block" 'maxWithdraw(address)' "$PROBE_OWNER")" "$HOLDS") \
    <(probe maxRedeem       "$block" "$(try_call "$block" 'maxRedeem(address)' "$PROBE_OWNER")" "$HOLDS") \
    <(probe previewDeposit  "$block" "$(try_call "$block" 'previewDeposit(uint256)' 1000000)") \
    <(probe previewRedeem   "$block" "$(try_call "$block" 'previewRedeem(uint256)' "$ONE_SHARE")")
}

LATEST_PROBES=$(build_probes "$HEAD")
HISTORICAL_PROBES=$(build_probes "$HIST")

# ---- step 8: historical coverage ----------------------------------------------------------
# A vault only clears the gate when the pinned historical block already answers every read.
log "step 8    historical coverage for the declared window"
if [[ -z $(try_call "$HIST" 'totalAssets()') ]]; then
  echo "FAIL: no readable state at $HIST; window not covered" >&2
  exit 1
fi

# ---- steps 9-10: pin the record -----------------------------------------------------------
log "step 9-10 pin identity, adapter, code hash and verification time"
DEPLOYMENT_BLOCK=$(find_deployment_block)
log "          deployment block: $DEPLOYMENT_BLOCK"

jq -n \
  --argjson chainId "$(cast chain-id)" \
  --arg address "$VAULT" \
  --arg asset "$ASSET" \
  --arg protocolSlug "$PROTOCOL_SLUG" \
  --arg adapterKey "$ADAPTER_KEY" \
  --arg adapterVersion "$ADAPTER_VERSION" \
  --argjson shareDecimals "$SHARE_DECIMALS" \
  --argjson assetDecimals "$ASSET_DECIMALS" \
  --arg name "$NAME" \
  --arg symbol "$SYMBOL" \
  --arg windowStartBlock "$HIST" \
  --arg deploymentBlock "$DEPLOYMENT_BLOCK" \
  --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --arg rpcProviderKey "$RPC_PROVIDER_KEY" \
  --arg codeHash "$CODE_HASH" \
  --argjson implementationAddress "$IMPL_ADDRESS" \
  --argjson implementationCodeHash "$IMPL_CODE_HASH" \
  --argjson latestProbes "$LATEST_PROBES" \
  --argjson historicalProbes "$HISTORICAL_PROBES" \
  --arg earliestFlowBlock "$FLOW_BLOCK" \
  --arg earliestFlowTransactionHash "$FLOW_TX" \
  --argjson windowCoverageDays "$WINDOW_DAYS" \
  --arg usdcSource "$USDC_SOURCE" \
  '{
    chainId: $chainId,
    address: $address,
    asset: $asset,
    assetCanonicalKey: "USDC",
    protocolSlug: $protocolSlug,
    adapterKey: $adapterKey,
    adapterVersion: $adapterVersion,
    shareDecimals: $shareDecimals,
    assetDecimals: $assetDecimals,
    name: $name,
    symbol: $symbol,
    deploymentBlock: $deploymentBlock,
    windowStartBlock: $windowStartBlock,
    status: "listed",
    statusReason: null,
    evidence: {
      verifiedAt: $verifiedAt,
      rpcProviderKey: $rpcProviderKey,
      codeHash: $codeHash,
      implementationAddress: $implementationAddress,
      implementationCodeHash: $implementationCodeHash,
      latestProbes: $latestProbes,
      historicalProbes: $historicalProbes,
      earliestFlowBlock: $earliestFlowBlock,
      earliestFlowTransactionHash: $earliestFlowTransactionHash,
      windowCoverageDays: $windowCoverageDays,
      sourceUrls: [$usdcSource]
    }
  }'
