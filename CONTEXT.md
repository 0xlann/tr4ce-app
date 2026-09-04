# TR4CE Agent Context

Use this file to orient an agent with no prior conversation. It records non-obvious product decisions and research findings; normative requirements live in the linked specifications.

## 1. What TR4CE is

TR4CE is an ETHOnline 2026 product for reproducible ERC-4626 vault evidence and policy-bound action preparation.

> It tells a human or agent what a vault did at identified blocks, whether that evidence satisfies explicit rules, and what an exact simulated deposit/redemption would do before the wallet owner approves it.

The old working name was **VaultProof**. Use **TR4CE** everywhere in new product artifacts. Historical strategy documents may still say VaultProof; that is the same concept before naming.

## 2. Why this product exists

The strongest event fit is The Graph’s composable/standardized data track. The valuable combination is:

- reusable ERC-4626 historical data;
- deterministic evidence rather than advertised APY;
- typed agent tools;
- a real user-approved action.

The product fails strategically if it becomes a hard-coded dashboard, generic agent SDK generator, or sponsor collage.

## 3. Decisions that are already made

1. MVP compares USDC-denominated vaults only.
2. Select 3–5 real vaults only after executable onboarding verification.
3. Primary metric is **observed share-value return** based on historical `convertToAssets` observations.
4. Do not call that metric realized APY or strategy yield.
5. Results are `PASS`, `FAIL`, or `UNKNOWN`; missing required evidence cannot pass.
6. Policy has five rule types: underlying asset, history, TVL in asset units, observed return, and account withdrawal capacity.
7. Natural language may draft typed policy, but deterministic validation/evaluation owns behavior.
8. TR4CE has no custom smart contract in the MVP.
9. Services prepare and simulate unsigned direct ERC-4626 calls; the wallet owner signs.
10. Exact allowances only; no unlimited approval.
11. HTTP, MCP, and web consume one evidence/report contract.
12. No multi-asset USD comparison, universal risk score, autonomous custody, token, or cross-chain execution.

Do not reopen these decisions without new primary-source or runtime evidence.

## 4. Critical research findings

### ERC-4626 is an accounting interface, not a safety standard

`convertToAssets` is an idealized average conversion that excludes fees and ignores limits/slippage. `previewRedeem` includes fees but ignores redemption limits. `maxWithdraw`/`maxRedeem` express limits but may underestimate.

A vault can conform to ERC-4626 while having very different strategy, governance, oracle, liquidity, and upgrade risks. TR4CE must never output “safe vault.”

### “Realized APY” was inaccurate

A historical change in one-share `convertToAssets` is backward-looking share-value evidence. It can reflect strategy performance, fees, donations, accounting transitions, or attacks. User-realized P&L additionally depends on user cashflows and execution. Product copy and schemas were corrected accordingly.

### Capability differences are product data

Current Morpho Vault V2 documentation describes zero behavior for some `max*` methods despite ERC-4626-style asset flows. Never interpret raw zero as verified zero capacity without adapter semantics. Preserve raw result, adapter version, and `UNKNOWN` when unresolved.

### A ready-made official ERC-4626 Substreams package was not established

Official docs and hackathon material support building one. At event kickoff, search `substreams.dev`, record the result, then extend a compatible package or publish TR4CE’s minimal module. Do not claim an upstream contribution before acceptance.

### Current versus historical data are different clocks

The indexed head, RPC head, and simulation block can differ. A report selects one reproducible as-of block. An action may use newer account-specific reads, clearly labeled, and expires quickly.

## 5. Honest MVP proof

The judge should see:

1. the same reusable data schema running across real vaults;
2. one vault failing or becoming unknown for an understandable reason;
3. a calculation traced to exact start/end blocks and raw values;
4. typed MCP output matching the web report;
5. a simulated direct action and explicit wallet confirmation;
6. a fixed evaluation showing fewer unsupported claims/completeness failures than generic access.

One polished proof is stronger than ten protocol logos.

## 6. Build gates before UI polish

- Public provider serves required networks/history.
- Selected vault addresses, assets, bytecode, events, and historical calls verify.
- Three vaults fit one honest schema.
- Reorg/replay behavior works.
- Capability mismatch yields `UNKNOWN`.
- Deposit/redeem simulation succeeds on a pinned fork.

If these fail, narrow to one protocol. Do not fake cross-protocol comparability.

## 7. Vocabulary

| Term | Meaning |
|---|---|
| Vault identity | `(chainId, vaultAddress)` |
| Observation | Raw event or block-scoped contract result |
| Snapshot | Vault-wide accounting observation at one exact block |
| Evidence report | Immutable, versioned calculation over cited observations |
| Observed share-value return | Historical `convertToAssets(one share)` change |
| Policy | User-confirmed, typed five-rule JSON |
| Unknown | Required evidence missing, stale, incompatible, reverted, or semantically unresolved |
| Capability profile | Versioned record of method behavior and adapter interpretation |
| Prepared action | Unsigned exact transaction(s) bound to account/chain/calldata/block |
| Simulation | RPC result for one prepared action; not a guarantee of inclusion |
| Provenance | Source, method/event, contract, block/hash, schema, and timestamp |

## 8. Document reading order

1. [PRD](./docs/PRD.md) — user, scope, requirements, metrics, release gates.
2. [Architecture](./docs/technical/ARCHITECTURE.md) — components, flows, trust boundaries.
3. [Integrations](./docs/technical/INTEGRATIONS.md) — verified external contracts and issue register.
4. [ERD](./docs/technical/ERD.md) — onchain/offchain persistence and units.
5. [Smart-contract interactions](./docs/technical/SMART-CONTRACT.md) — direct ERC-4626 action contract.
6. [Tech stack](./docs/technical/TECH-STACK.md) — implementation choices and rejected weight.
7. [Design system](./docs/DESIGN-SYSTEMS.md) — visual/copy/accessibility contract.
8. [Build plan](./docs/BUILD-PLAN.md) — implementation sequence and checks.
9. [Installation](./docs/technical/INSTALLATION.md) — tooling, skills, secrets, bootstrap.

When documents disagree: PRD owns product behavior; Architecture owns boundaries; ERD owns persisted units/relationships; Smart Contract owns transaction invariants. Update all affected documents in one change.

## 9. Agent working rules

- Verify current external facts from official docs or source before changing integration claims.
- Never invent a vault address, package availability, APY, block, or test output.
- Use exact units and stable reason codes.
- Keep pure evidence/policy logic independent from I/O and UI.
- Treat LLM output, metadata, RPC, Graph, wallet state, and revert strings as untrusted inputs.
- Fix the shared source of truth; do not duplicate schemas across web/API/MCP.
- Before changing an exported type/interface, update every consumer and test.
- Runtime proof outranks prose: live query, pinned fork, schema validation, and end-to-end simulation.
- Label live, forked, cached, and illustrative evidence visibly.

## 10. Current repository/tool state

This repository currently contains TR4CE planning artifacts, not an implementation.

Verified:

- supplied logo at `tr4ce-logo.png`;
- complete TR4CE technical docs under `technical/`;
- no project-local Codex skills are installed yet.

Add implementation dependencies and selected `.agents/skills` only when their scope is approved.

## 11. Brand constraints

The supplied logo uses deep green near `#035535`/`#025234` on cream near `#FDF3E5`. The branching mark communicates lineage. Evidence/provenance must dominate visual hierarchy. Green cannot be the only status signal, and “safe,” “guaranteed,” “AI verified,” and “best vault” are prohibited unless a narrowly stated policy/metric makes the claim exact.

## 12. Primary source map

- Event/rules: [ETHOnline](https://ethglobal.com/events/ethonline2026), [prizes](https://ethglobal.com/events/ethonline2026/prizes)
- Standard: [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626)
- Data: [Substreams](https://thegraph.com/docs/en/substreams/overview/), [Substreams Skills](https://thegraph.com/docs/en/substreams/tooling/skills/), [EVM calls](https://docs.substreams.dev/tutorials/eth-calls)
- Agents: [The Graph AI overview](https://thegraph.com/docs/en/ai-overview/), [Subgraph MCP](https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/)
- Protocol caveat: [Morpho vault mechanics](https://docs.morpho.org/developers/earn/concepts/vault-mechanics/), [asset flows](https://docs.morpho.org/developers/earn/tutorials/assets-flow/)

## 13. Unknowns to resolve at implementation kickoff

These are validation gates, not permission for placeholders in shipped code:

- final event dashboard classification and duplicate-prize rules;
- best compatible package currently available on `substreams.dev`;
- selected networks and exact 3–5 vault manifest;
- live provider history and block-call behavior for those vaults;
- whether WalletConnect is required for the demo;
- whether an LLM provider adds measurable value beyond the typed form.

Resolve each with official/runtime evidence and record the result in source-controlled manifests or decisions.
