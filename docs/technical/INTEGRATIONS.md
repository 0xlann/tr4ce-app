# TR4CE Integrations

**Rule:** An integration is included only when it supplies evidence, execution, or a qualifying reusable interface. Sponsor-logo accumulation is out of scope.

## 1. Integration matrix

| Integration | Status | Purpose | Build-time proof |
|---|---|---|---|
| The Graph Substreams provider | Required | Historical canonical block stream | Public endpoint and live run command |
| ERC-4626 Substreams package | Required; built by TR4CE | Reusable normalized vault flows/snapshots | Published package, protobuf schema, tests, README |
| Built-in PostgreSQL Database Changes sink | Required | Reorg-aware raw staging history | Same schema populated for all curated vaults |
| EVM JSON-RPC via viem | Required | Current block-scoped reads, simulation, receipts | Real contract calls and successful simulation |
| ERC-4626 vaults | Required | Source of accounting and actions | Curated identity/capability verification |
| User wallet via wagmi | Required for actions | Explicit signatures | User-confirmed deposit/redeem |
| TR4CE MCP server | Required | Typed agent evidence/action preparation | Six tools and repeatable evaluation |
| Subgraph MCP | Optional | Agent exploration of published Subgraph | Add only if it improves the measured workflow |
| LLM provider | Optional | Plain-language to policy draft | Typed validator rejects unsupported output |

## 2. The Graph data plane

### Officially supported facts

- Substreams processes high-throughput blockchain history and supports composable modules.
- Official Substreams Skills cover package discovery, EVM decoding, SQL sinks, testing, and deployment.
- Substreams EVM contract calls can read block-scoped contract state and can be batched.
- The Subgraph MCP searches schemas and executes GraphQL queries; it is not a generic Substreams streaming MCP.
- The ETHOnline brief names reusable ERC-4626 vault flows as an eligible composable module direction.

### Package contract

`proto/tr4ce/v1/vault.proto` exposes:

```proto
message VaultBlockBatch {
  uint64 chain_id = 1;
  uint64 block_number = 2;
  bytes block_hash = 3;
  google.protobuf.Timestamp block_time = 4;
  repeated Deposit deposits = 5;
  repeated Withdraw withdrawals = 6;
  repeated ShareTransfer share_transfers = 7;
  repeated VaultSnapshot snapshots = 8;
  string schema_version = 9;
}
```

`Deposit`, `Withdraw`, and `ShareTransfer` are separate protobuf message types with named typed event fields. A generic `event_name`/raw-bytes/JSON event bag is prohibited. Mint/redeem attribution uses the standard events without double counting share mint/burn transfers as another economic flow.

Required snapshot raw fields: vault, asset, share decimals, asset decimals, total assets, total supply, one-share `convertToAssets` result, success/revert status, and block identity.

### Efficiency rules

- Filter to curated vault addresses before expensive decoding/calls.
- Prefer log data where it is sufficient.
- Batch contract reads by block.
- Do not snapshot every vault every block. Snapshot on relevant activity plus scheduled checkpoints sufficient for the declared windows.
- Record actual observation timestamps; a 30-day query does not pretend the nearest block is exactly 30 days earlier.

### Issue: no verified ready-made ERC-4626 package

**Finding:** Official docs and hackathon material support creating the module; research did not establish an official production ERC-4626 package that TR4CE can simply consume.

**Solution:** Search the Substreams registry at kickoff, record the result, and either extend the best compatible package or publish TR4CE’s minimal package. Do not claim an upstream contribution until maintainers accept it.

## 3. ERC-4626 contracts

### Required reads

| Method | Correct use | Important limitation |
|---|---|---|
| `asset()` | Canonical underlying address | Identity still requires chain and contract verification |
| `totalAssets()` | Vault-reported managed assets | Strategy/accounting semantics remain vault-specific |
| `totalSupply()` | Share supply | Zero supply needs explicit handling |
| `convertToAssets(shares)` | Idealized average conversion | Excludes fees, ignores limits/slippage, rounds down |
| `maxWithdraw(owner)` | Asset-denominated owner limit | May underestimate; some implementations are intentionally non-standard |
| `maxRedeem(owner)` | Share-denominated owner limit | Same capability caveat |
| `previewDeposit(assets)` | Deposit share estimate | Does not enforce all limits; can differ by execution block |
| `previewRedeem(shares)` | Redemption asset estimate including fees | Ignores redemption limits; pair with `maxRedeem`/simulation |

### Required events

```solidity
event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
event Withdraw(
  address indexed sender,
  address indexed receiver,
  address indexed owner,
  uint256 assets,
  uint256 shares
);
```

Share `Transfer` comes from ERC-20. Flow analytics MUST define whether mint/burn transfer events are excluded from transfer-volume metrics to prevent double counting.

### Issue: interface compliance does not equal comparable semantics

**Solution:** Curated capability tests and a versioned protocol adapter. Store raw results and adapter notes. Any unresolved mismatch yields `UNKNOWN`.

### Issue: donation/share-inflation effects

A share-value increase can come from direct asset donation, strategy gain, fee/accounting behavior, or an attack surface—not only organic yield.

**Solution:** Call the metric observed share-value return; show flows and discontinuities; flag abrupt changes; never label the value “strategy yield” without protocol-specific evidence.

## 4. Vault selection and onboarding

The MVP starts with USDC-denominated vaults. A vault is listed only after this executable gate:

1. Resolve chain ID and checksummed vault address.
2. Confirm non-empty bytecode at the address.
3. Call `asset()` and match a canonical USDC deployment for that chain.
4. Read share/asset decimals and reject unsupported ranges.
5. Call every required read method at latest and one historical block.
6. Decode `Deposit` and `Withdraw` from known transactions or a bounded historical range.
7. Record capability outcomes, including reverts and non-standard zeros.
8. Verify enough historical coverage for at least one declared window.
9. Simulate a dust-safe preview and one forked deposit/redeem path.
10. Pin the vault, protocol adapter, deployment bytecode hash, and verification timestamp.

Candidate protocol families: Morpho Vault V2 and Yearn V3, subject to this gate. Exact addresses are deliberately not frozen in planning documents because deployments and useful liquidity change. The selected-address manifest becomes an event-period source artifact.

## 5. RPC and simulation

Use viem public clients per chain with explicit chain definitions.

### Provider contract

- archive/block-specific calls for historical verification;
- `eth_call` and `eth_estimateGas` for current simulation;
- receipt and block-hash retrieval;
- provider identity and latency in provenance;
- bounded timeout and retry only for idempotent reads.

Do not silently fall back from requested historical block to `latest`.

### Simulation order

Deposit:

1. verify chain/account/vault/asset;
2. read balance and allowance;
3. read `maxDeposit` and `previewDeposit` where supported;
4. simulate exact approval if needed;
5. simulate exact deposit call;
6. return both unsigned transactions in order.

Redeem:

1. read share balance;
2. read `maxRedeem`/`maxWithdraw` and raw capabilities;
3. call `previewRedeem`;
4. simulate exact `redeem`;
5. return one unsigned transaction.

### Issue: stale simulation

**Solution:** Bind simulation to chain, account, calldata hash, value, and block. Expire after 3 blocks or 60 seconds and rerun immediately before wallet request.

## 6. Wallet integration

Use wagmi with viem. Required connectors for MVP:

- injected EIP-1193 wallet;
- WalletConnect only if the demo requires mobile signing.

Wallet requirements:

- read-only product works disconnected;
- wrong network produces an explicit switch request;
- exact amount approval only;
- no seed/private-key input;
- transaction hash and receipt are displayed independently;
- account/network change clears prepared actions.

## 7. MCP and SKILL surface

TR4CE hosts its own MCP server because its value is the normalized evidence contract, not generic GraphQL access.

| Tool | Side effect | Output |
|---|---|---|
| `search_vaults` | None | Vault identities, capabilities, freshness |
| `get_evidence` | None | Immutable evidence report |
| `evaluate_policy` | None | Per-rule result and evidence refs |
| `prepare_deposit` | None | Unsigned approval/deposit calls + simulation |
| `prepare_redeem` | None | Unsigned redeem call + simulation |
| `get_action_status` | None | Transaction receipt state for caller-supplied hash |

“Prepare” is not “execute.” MCP clients never send transactions through TR4CE.

The public `SKILL.md` documents:

- when to use each tool;
- exact units and schemas;
- evidence limitations;
- `PASS`/`FAIL`/`UNKNOWN` semantics;
- requirement for wallet confirmation;
- examples that do not promise future APY.

## 8. Database and sink

PostgreSQL is the only persistence service. The built-in `substreams sink postgres` Database Changes mode writes a reorg-aware raw staging schema. The application worker promotes only observations older than the configured confirmation depth into the constrained application tables in [ERD](./ERD.md). Normal pre-confirmation reorgs are handled by the sink; a deep reorg invalidates promoted observations and dependent reports.

No Redis is required initially. Use database-backed job claiming (`FOR UPDATE SKIP LOCKED`) only if one process is insufficient; otherwise run one worker.

## 9. LLM integration

Optional and isolated to policy drafting.

```text
plain language
  -> provider response
  -> strict JSON parse
  -> JSON Schema validation
  -> typed preview
  -> user confirmation
```

Provider output cannot:

- introduce new rule operators;
- choose an address from an unverified ticker;
- calculate evidence;
- mark a policy pass;
- sign or submit a transaction.

The manual form remains the fallback and canonical editing surface.

## 10. Integration issues register

| Risk | Detection | Resolution | Failure state |
|---|---|---|---|
| Graph indexed head lags | Compare head to confirmed RPC | Label stale; wait or use older common block | Report generation blocked if window incomplete |
| Historical `eth_call` unavailable | Call selected old block during onboarding | Use The Graph block-scoped call/provider with proven history | Vault not onboarded |
| Vault upgrades implementation | Track bytecode/proxy implementation | Start new capability version and compatibility review | Cross-version return `UNKNOWN` |
| `maxWithdraw` non-standard | Capability suite + official protocol docs | Preserve raw zero, adapter note, simulation | Rule `UNKNOWN` unless semantics verified |
| RPC disagreement | Compare block hash/critical reads across providers | Quarantine observation and retry against canonical block | `UNKNOWN` |
| Chain reorg | Stored block hash differs | Rewind and invalidate dependents | Report/action invalid |
| USDC deployment mismatch | Canonical chain manifest | Reject ticker-only match | Vault unsupported |
| Token metadata malicious | Bounded ABI decode and escaped output | Prefer curated metadata | Identity warning/unsupported |
| Unlimited allowance requested | Action invariant | Exact amount only | Action rejected |
| MCP caller asks to execute | Tool schema has no submit operation | Return unsigned data only | Structured unsupported-operation error |

## 11. Go/no-go checklist

Before UI implementation:

- [ ] Public provider serves the chosen networks and historical range.
- [ ] Registry search for reusable ERC-4626 modules is documented.
- [ ] Three vaults pass the onboarding gate.
- [ ] Same protobuf/query schema works across them.
- [ ] Historical `convertToAssets` observations reproduce.
- [ ] At least one real/forked deposit and redemption simulate.
- [ ] Capability mismatch produces `UNKNOWN`, not a misleading zero.

If the first four checks fail, narrow the product before building the dashboard.

## 12. Sources

- [ERC-4626 specification](https://eips.ethereum.org/EIPS/eip-4626)
- [The Graph Substreams overview](https://thegraph.com/docs/en/substreams/overview/)
- [The Graph Substreams Skills](https://thegraph.com/docs/en/substreams/tooling/skills/)
- [Substreams package registry](https://substreams.dev/)
- [Substreams EVM calls](https://docs.substreams.dev/tutorials/eth-calls)
- [The Graph Subgraph MCP](https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/)
- [Morpho Vault ERC-4626 mechanics](https://docs.morpho.org/developers/earn/concepts/vault-mechanics/)
- [Morpho vault asset-flow caveats](https://docs.morpho.org/developers/earn/tutorials/assets-flow/)
- [viem contract simulation](https://viem.sh/docs/contract/simulateContract)
- [wagmi documentation](https://wagmi.sh/)
