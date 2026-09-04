# tr4ce-erc4626

A reusable Substreams package that emits normalized, typed ERC-4626 vault observations:
`Deposit`, `Withdraw`, `ShareTransfer`, and block-scoped `VaultSnapshot` messages, plus a
PostgreSQL Database Changes output.

The curated vault set is a **runtime parameter**, not a compile-time constant, so anyone can
point this module at their own ERC-4626 vaults without rebuilding.

## Modules

| Module | Kind | Output |
|---|---|---|
| `map_vault_events` | map | `proto:tr4ce.v1.VaultEvents` |
| `map_vault_block_batch` | map | `proto:tr4ce.v1.VaultBlockBatch` |
| `db_out` | map | `proto:sf.substreams.sink.database.v1.DatabaseChanges` |

## Registry search and reuse decision

BUILD-PLAN Task 2 requires searching the Substreams registry before writing a package, and
recording the result. `CONTEXT.md` §4 recorded this as an open question at planning time.

**Searched:** 2026-09-04, `GET https://substreams.dev/v1/registry/packages?query=<q>` (public, no auth).

| Query | Packages returned |
|---|---|
| `erc4626` | none |
| `erc-4626` | none |
| `tokenized-vault` | none |
| `vault shares` | none |
| `vault` | `rari-vaults-substreams` v0.1.0 (mainnet), `zebec_vault_substreams` v0.1.0 (solana-devnet) |
| `morpho` | `morpho-blue-substreams` v0.1.0 (mainnet) |
| `yearn` | `yearn-v2-substreams` v0.1.0 (mainnet) |

**Finding:** the registry contains no generic ERC-4626 package. Every vault-related package
found is scoped to one protocol and published for Ethereum mainnet only. None targets Base,
and none exposes a protocol-agnostic ERC-4626 event/snapshot schema.

**Decision: publish TR4CE's own minimal generic module rather than extend an existing package.**

Rationale:

- There is no compatible generic package to extend; extending a protocol-specific package
  (Morpho Blue, Yearn V2, Rari) would inherit that protocol's schema and defeat the goal of one
  normalized contract spanning multiple protocols.
- `morpho-blue-substreams` covers Morpho Blue, the lending primitive, which is a different
  contract surface from the ERC-4626 vaults TR4CE observes.
- `yearn-v2-substreams` targets Yearn V2; ERC-4626 conformance arrived in Yearn V3.
- All candidates are published for `mainnet`; TR4CE targets Base.

No upstream contribution is claimed. Per `CONTEXT.md` §4, a contribution is only claimed once
maintainers have accepted it.

## Curated vaults

Four USDC vaults on Base, each one put through the ten-step onboarding gate in
`docs/technical/INTEGRATIONS.md` section 4 against live chain state before being listed. The
recorded evidence lives in `packages/test-vaults/src/manifest.json`.

| Vault | Protocol | Share decimals | Proxy |
|---|---|---|---|
| `gtUSDCp` Gauntlet USDC Prime | Morpho | 18 | no |
| `ymvOG-USDC` Yearn OG USDC | Morpho | 18 | no |
| `ysUSDC` Morpho Yearn Vault 1 Compounder | Yearn V3 | 6 | yes |
| `yvUSDC-H` USDC Horizon yVault | Yearn V3 | 6 | no |

The address list is a runtime parameter, not a compile-time constant, so pointing this module at a
different vault set needs no rebuild:

```bash
substreams run substreams.yaml map_vault_block_batch \
  -p map_vault_block_batch='chain_id=8453&anchor_block=<n>&checkpoint_interval=1800&vaults=<addr>:<asset>:18:6'
```

## Snapshot cadence

A vault is snapshotted when it sees a deposit or withdrawal, on every block where
`block_number % checkpoint_interval == 0`, and at the declared window start. The checkpoint test is
a stateless modulo rather than a running counter, so a replay produces identical rows and the
backfill still parallelises.

## Prerequisites

- Rust stable with the `wasm32-unknown-unknown` target
- `substreams` CLI, authenticated (`SUBSTREAMS_API_TOKEN`)
- `buf`, required by `substreams build`

## Quick start

```bash
export SUBSTREAMS_API_TOKEN=<the-graph-market-jwt>

substreams build

# One block at the declared window start: every curated vault is observed.
substreams run -e base-mainnet.streamingfast.io:443 substreams.yaml map_vault_block_batch \
  --start-block 50577041 --stop-block +1 -o json

# A block carrying a real deposit into Gauntlet USDC Prime.
substreams run -e base-mainnet.streamingfast.io:443 substreams.yaml map_vault_block_batch \
  --start-block 50878912 --stop-block +1 -o json
```

Sink a bounded range into PostgreSQL:

```bash
export SUBSTREAMS_SINK_DSN="psql://tr4ce:tr4ce@localhost:5432/tr4ce?sslmode=disable"
substreams sink postgres setup tr4ce-erc4626-v0.1.0.spkg
substreams sink postgres tr4ce-erc4626-v0.1.0.spkg \
  -s 50577041 -t +2 --batch-block-flush-interval=1
```

The flush interval matters: it defaults to 1000 blocks, so a short smoke range never reaches
PostgreSQL without it.

## Verification

`tests/check-live.sh` runs the module against pinned Base blocks and asserts on the real output,
including a diff against the golden fixtures in `tests/fixtures/`.

```bash
SUBSTREAMS_API_TOKEN=<jwt> ./tests/check-live.sh
```

## Notes on the toolchain

Three things cost time to discover and are recorded here so they do not have to be rediscovered.

- **`substreams run --test-file` is inert in CLI v1.22.0.** An assertion expecting `999` where the
  real value is `4` still reports "Completed successfully" with exit 0. `tests/check-live.sh`
  exists because of this; do not rely on `--test-file` as a gate.
- **The sink offers no way to place tables in a dedicated schema.** There is no `--schema` flag, a
  `?schema=` DSN parameter is rejected by Postgres outright, a `search_path=` parameter is accepted
  and then ignored for DDL, and table identifiers are quoted so `raw_erc4626.deposit` would become
  one literal name. The namespace is carried in the table name instead: `raw_erc4626_*`.
- **A `JSONB` column breaks the Database Changes sink.** The value is emitted unquoted, producing
  `VALUES (..., [], ...)` and a SQL syntax error. `call_errors` is therefore `TEXT` in raw staging;
  the promotion worker casts it when writing the application table.
