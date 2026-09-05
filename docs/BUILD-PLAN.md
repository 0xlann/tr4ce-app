# TR4CE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build an evidence-first ERC-4626 research and action product using live standardized The Graph data.  
**Architecture:** A Rust Substreams package produces normalized historical observations; TypeScript domain packages deterministically build reports and evaluate policy; HTTP, MCP, and web surfaces share those packages; wallets sign direct ERC-4626 actions.  
**Tech stack:** Rust/Substreams, TypeScript, Node, Next.js, Hono, MCP SDK, viem/wagmi, PostgreSQL/Drizzle, pnpm/Turborepo.  
**Spec:** [`PRD.md](./PRD.md)`  
**Technical contracts:** [`technical/ARCHITECTURE.md`](./technical/ARCHITECTURE.md), [`technical/ERD.md`](./technical/ERD.md), [`technical/SMART-CONTRACT.md`](./technical/SMART-CONTRACT.md)

## Global constraints

- MVP compares only verified USDC-denominated ERC-4626 vaults.
- `PASS` requires every required policy rule to pass; missing evidence is `UNKNOWN`.
- Token amounts and block numbers never use JavaScript floating point.
- Historical return is named “observed share-value return,” not realized or guaranteed APY.
  - Services never ingest private keys or submit transactions.
- State-changing actions use direct vault calls, exact allowances, simulation, and explicit wallet approval.
- No custom TR4CE contract, cross-chain execution, autonomous custody, token, or universal safety score.

## Target file map

```text
apps/web         product UI and wallet confirmation
apps/api         versioned HTTP application boundary
apps/mcp         six typed read/prepare tools
apps/worker      confirmed-row promotion, current refresh, deep-reorg invalidation
packages/domain  IDs, values, reason codes, response contracts
packages/evidence pure evidence calculations
packages/policy  JSON Schema and deterministic evaluator
packages/chain   ERC-4626 reads, calldata, simulation, receipts
packages/db      schema, migrations, repositories
packages/contracts verified ABIs/generated viem types
packages/test-vaults event-period verified vault manifest
substreams/erc4626 reusable historical data package
evals            fixed prompts, rubric, results
skill/SKILL.md    public agent guidance
```

---

## Task 1: Establish the typed workspace and domain contract

**Files:**

- Create root workspace files: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.env.example`, `docker-compose.yml`
- Create: `packages/domain/src/{identity,amounts,evidence,policy,actions,reasons}.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/domain.test.ts`

**Produces:** Versioned types used by every later task: `VaultIdentity`, `BlockRef`, `EvidenceReportV1`, `PolicyV1`, `PreparedActionV1`, and stable reason codes.

- [x] Pin Node/pnpm and scaffold only the directories in the target map.
- [x] Define branded/validated address, chain, block, base-unit, and basis-point boundaries; JSON uses decimal strings.
- [x] Define `PASS | FAIL | UNKNOWN` and the canonical reason-code union.
- [x] Define evidence/action Zod schemas first, infer TypeScript types, and export generated JSON Schema.
- [x] Write tests that reject floating amounts, malformed addresses, unknown enum values, and reports missing provenance.
- [x] Run `pnpm --filter @tr4ce/domain test` and `pnpm --filter @tr4ce/domain typecheck`; expect both to pass.
- [x] Commit as `feat(tr4ce): define domain contracts`.

Acceptance: A valid example report round-trips through JSON; converting every bigint field to JSON requires an explicit decimal-string boundary.

## Task 2: Build and publish the ERC-4626 Substreams package

**Files:**

- Create: `substreams/erc4626/substreams.yaml`
- Create: `substreams/erc4626/{Cargo.toml,build.rs,README.md}`
- Create: `substreams/erc4626/proto/tr4ce/v1/vault.proto`
- Create: `substreams/erc4626/src/{lib,abi,events,snapshots,db_out}.rs`
- Create: `substreams/erc4626/abi/erc4626.json`
- Create: `substreams/erc4626/tests/fixtures/*`
- Create: `packages/test-vaults/src/manifest.ts`

**Consumes:** Curated manifest schema from `@tr4ce/domain`.  
**Produces:** Separate typed `Deposit`, `Withdraw`, and `ShareTransfer` protobuf messages, block snapshots, and PostgreSQL Database Changes output.

- [x] Search `substreams.dev`; record exact compatible packages and extend/reuse decision in the package README.
- [x] Add one candidate vault, verify chain/address/code, `asset()`, events, and historical calls before adding more.
- [~] Write failing `substreams::testing::map!` and real-block fixture tests for separate typed `Deposit`, `Withdraw`, and `ShareTransfer` messages, mint/burn exclusion, and reverted block-scoped calls. **Partly done.** Mint/burn classification and reverted block-scoped calls are covered by pure unit tests in `events.rs` and `snapshots.rs`, and the typed messages are asserted against live Base by `tests/check-live.sh` plus golden fixtures. Still missing: `substreams::testing::map!` handler tests, and offline `firecore` block fixtures so decoding can be tested without a network. See issue #2.
- [x] Implement address filtering and ABI decoding into one dedicated protobuf type per event; never emit a generic raw/JSON event bag.
- [x] Implement batched block-scoped reads for `totalAssets`, `totalSupply`, decimals, and one-share `convertToAssets`; represent per-method failures, never panic on a vault revert.
- [x] Add two more verified vaults using the same protobuf and tests; span two protocols or networks only if honest comparability passes.
- [x] Run `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `substreams build`, and a bounded pinned `substreams run -o jsonl`; compare the CLI output with a reviewed golden fixture.
- [ ] Publish the versioned package and record package hash/endpoint. **Held pending a public-visibility decision; see issue #1.**
- [ ] Commit as `feat(tr4ce): publish normalized erc4626 stream`.

Acceptance: The same module and output schema emit data for at least three verified vaults; no address-specific branch exists in generic event decoding.

## Task 3: Persist canonical observations and survive replay/reorg

**Files:**

- Create: `packages/db/src/schema/{registry,observations,cursors}.ts`
- Create: `packages/db/src/repositories/{vaults,observations,cursors}.ts`
- Create: `packages/db/migrations/0001_registry_observations.sql`
- Create: `apps/worker/src/{promote-confirmed,reconcile-deep-reorg}.ts`
- Test: `packages/db/src/observations.integration.test.ts`

**Consumes:** Reorg-aware raw tables populated by `substreams sink postgres`.  
**Produces:** Confirmed, constrained application observations.

- [x] Define a dedicated raw sink schema using PostgreSQL Database Changes and the constrained application schema from the ERD.
- [x] Write an integration test that replays the same raw rows/promotion and expects identical application rows.
- [~] Write a pre-confirmation reorg test proving the sink undoes raw changes before promotion.
- [x] Write a deep-reorg test that marks promoted observations non-canonical and invalidates dependent reports.
- [x] Implement promotion for rows at or below `confirmedHead = rpcHead - confirmationDepth`, recording exact block hash.
- [x] Commit promotion rows and application cursor atomically; validate producer/schema version before commit.
- [x] Run the built-in PostgreSQL sink, migrations, promotion, and integration tests against a fresh database.
- [x] Commit as `feat(tr4ce): promote canonical vault evidence`.

> **Partly done.** A Base reorg cannot be produced on demand, and the undo itself is the sink's
> code, not ours. What is tested is the property the acceptance clause actually rests on: promotion
> never reads above the confirmed head, so anything the sink is still entitled to undo has never
> reached the application tables — asserted in `observations.integration.test.ts` by promoting a
> range, deleting the unconfirmed raw rows exactly as a sink undo would, and re-promoting. The test
> is named for what it proves. Observing a real pre-confirmation reorg on Base would need a run
> held at chain head over a reorg, which is not reproducible in CI.
>
> **Deviation from ERD section 6:** minimal `evidence_report`, `report_observation`, and an
> append-only `reorg_invalidation` table ship in `0001_registry_observations.sql`, because
> "invalidates every promoted dependent" cannot be demonstrated against tables that do not exist.
> Task 6 extends these columns; it does not replace them.

Acceptance: Normal reorgs are removed in staging before promotion; replay is idempotent; a detected deep reorg invalidates every promoted dependent.

## Task 4: Implement the pure evidence engine

**Files:**

- Create: `packages/evidence/src/{rational,share-value,flows,report}.ts`
- Test: `packages/evidence/src/{share-value,flows,report}.test.ts`

**Consumes:** Immutable snapshots, flow rows, capability profile.  
**Produces:** `EvidenceReportV1` without I/O.

Core contract:

```ts
export function observedShareValueReturn(
  startAssets: bigint,
  endAssets: bigint,
): { numerator: bigint; denominator: bigint; bps: number };

export function buildEvidence(input: EvidenceInput): EvidenceReportV1;
```

- [ ] Write failing tests for positive/negative/zero return, round-down boundary, zero denominator, missing start, incompatible decimals, and actual elapsed window.
- [ ] Implement reduced rational arithmetic and explicit basis-point rounding.
- [ ] Write flow tests that exclude mint/burn transfer duplication and separate deposits from withdrawals.
- [ ] Write report tests proving every value carries source references and limitations.
- [ ] Add a reproducibility fixture: canonical input hash and report JSON remain stable.
- [ ] Run package tests and property cases across bounded bigint ranges.
- [ ] Commit as `feat(tr4ce): calculate reproducible vault evidence`.

Acceptance: Missing/incompatible evidence yields structured `UNKNOWN` inputs; no `number` arithmetic touches token amounts.

## Task 5: Implement capability-aware reads and policy evaluation

**Files:**

- Create: `packages/chain/src/{abis,vault-reader,capabilities}.ts`
- Create: `packages/policy/src/{schema,compile,evaluate}.ts`
- Test: `packages/chain/src/vault-reader.fork.test.ts`
- Test: `packages/policy/src/{schema,evaluate}.test.ts`

**Produces:** Current raw reads, five-rule `PolicyV1`, per-rule decision.

- [ ] Pin one fork block for each curated vault and test every required ERC-4626 method.
- [ ] Preserve call value/revert and adapter interpretation separately.
- [ ] Write policy-schema tests for decimal strings, five supported rules, no unknown keys, bounded windows, and valid owner address.
- [ ] Implement truth table: any fail → fail; otherwise any required unknown → unknown; all pass → pass.
- [ ] Add test where a documented non-standard `maxWithdraw == 0` becomes `UNKNOWN`, not `FAIL` or `PASS`.
- [ ] Add optional natural-language compiler behind an interface; test invalid provider JSON never reaches evaluator.
- [ ] Run policy unit and chain fork tests.
- [ ] Commit as `feat(tr4ce): evaluate typed vault policy`.

Acceptance: Manual typed policy works with the LLM disabled; the LLM cannot add an operator or mark a rule pass.

## Task 6: Persist immutable reports and expose the API

**Files:**

- Create: `packages/db/src/schema/{policies,reports}.ts`
- Create: `packages/db/src/repositories/{policies,reports}.ts`
- Create: `apps/api/src/routes/v1/{vaults,reports,policies,actions}.ts`
- Create: `apps/api/src/services/{evidence-service,policy-service}.ts`
- Test: `apps/api/src/routes/v1/api.integration.test.ts`

**Produces:** Versioned HTTP endpoints with OpenAPI and immutable report URLs.

- [ ] Implement the remaining ERD migrations with report-observation foreign keys.
- [ ] Write a test that attempts to build a report from non-canonical observations and expects rejection.
- [ ] Implement `GET /v1/vaults`, `POST /v1/reports`, `GET /v1/reports/:id`, and `POST /v1/policies/evaluate`.
- [ ] Make report creation idempotent on canonical input hash + versions.
- [ ] Validate every request and response against shared schemas.
- [ ] Generate OpenAPI and fail CI on schema drift.
- [ ] Run API integration tests against a fresh database.
- [ ] Commit as `feat(tr4ce): expose immutable evidence api`.

Acceptance: Repeating a request over identical inputs returns the same report; HTTP output equals the domain schema exactly.

## Task 7: Prepare and simulate direct ERC-4626 actions

**Files:**

- Create: `packages/chain/src/{prepare-deposit,prepare-redeem,simulate,receipts}.ts`
- Create: `packages/db/src/schema/actions.ts`
- Test: `packages/chain/src/actions.fork.test.ts`
- Test: `apps/api/src/routes/v1/actions.integration.test.ts`

**Produces:** Unsigned action arrays, bound simulation, status tracking.

- [ ] Write fork tests for exact approval + deposit, redemption, wrong asset, over-balance, stale block, and changed account.
- [ ] Build calls directly to verified asset/vault; refuse unlimited allowance.
- [ ] Bind simulation to chain/account/to/data/value/block/capability version and expire at 3 blocks or 60 seconds.
- [ ] Persist no signature; accept transaction hash only after wallet submission.
- [ ] Decode receipt events and show preview-versus-actual values.
- [ ] Run fork and API tests.
- [ ] Commit as `feat(tr4ce): prepare simulated vault actions`.

Acceptance: There is no service method that signs or submits; changing any bound field makes the action non-signable until resimulation.

## Task 8: Expose MCP tools and public agent skill

**Files:**

- Create: `apps/mcp/src/{server,tools}.ts`
- Create: `skill/SKILL.md`
- Create: `evals/{prompts.jsonl,rubric.json}`
- Test: `apps/mcp/src/tools.protocol.test.ts`

- [ ] Register exactly six tools from the integrations specification.
- [ ] Reuse application services and Zod-generated schemas; do not duplicate calculations.
- [ ] Assert prepare tools return unsigned data and no submit method exists.
- [ ] Document units, limitations, freshness, errors, and wallet approval in `SKILL.md`.
- [ ] Test HTTP report JSON and MCP report JSON for canonical equality.
- [ ] Commit as `feat(tr4ce): add typed agent evidence tools`.

Acceptance: An MCP client can discover, evaluate, and prepare without unrestricted GraphQL or transaction submission.

## Task 9: Build the evidence-first web product

**Files:**

- Create routes under `apps/web/app/{search,reports/[id],actions/[id],evals}`
- Create components under `apps/web/components/{evidence,policy,provenance,actions}`
- Create: `apps/web/styles/tokens.css`
- Test: `apps/web/e2e/tr4ce.spec.ts`

- [ ] Implement design tokens from `DESIGN-SYSTEMS.md` and verify AA contrast.
- [ ] Build disconnected search and typed policy builder first.
- [ ] Build comparison with `PASS/FAIL/UNKNOWN`, completeness, and as-of block.
- [ ] Build report calculation/provenance disclosure and JSON view.
- [ ] Add wagmi action flow with chain/account invalidation and exact wallet preview.
- [ ] Add loading, stale, partial, reorged, simulation-failed, submitted, confirmed, and reverted states.
- [ ] Write Playwright path: policy → mixed results → report → simulation → mocked wallet handoff; use fork test for real EVM behavior.
- [ ] Test keyboard-only flow and mobile evidence parity.
- [ ] Commit as `feat(tr4ce): ship evidence-first interface`.

Acceptance: A user can explain a failed/unknown rule and inspect exact provenance without a wallet; no APY headline outranks policy status.

## Task 10: Evaluate, deploy, and prove the demo

**Files:**

- Create: `evals/run.ts`, `evals/results/*.json`
- Create deployment manifests/config for web, API/MCP, worker, migrations
- Create: `scripts/smoke-demo.ts`

- [ ] Run fixed prompts against baseline and TR4CE with model/settings/provider/time recorded.
- [ ] Score schema completeness, unsupported claims, exact decision, action validity, and completion time.
- [ ] Deploy PostgreSQL migration, API/MCP, one worker, then web.
- [ ] Run live smoke: public Graph query → report → policy → simulated action → wallet confirmation or explicitly labeled fork action.
- [ ] Verify reorg/partial-provider demo fixture and `UNKNOWN` behavior.
- [ ] Verify public repository, package link, endpoint, `SKILL.md`, source citations, and event-period diff.
- [ ] Run `pnpm verify`, Rust checks, external integration job, Playwright critical path, and `scripts/smoke-demo.ts` from a clean clone.
- [ ] Record exact commands and outputs in the submission evidence.
- [ ] Commit as `chore(tr4ce): verify production demo`.

Acceptance: A reviewer can reproduce one evidence report and understand exactly which parts were live, forked, or cached.

## Final self-review gate

Before implementation is called complete:

- Every PRD requirement maps to a task and executable check.
- No placeholder address, market claim, or hard-coded APY appears in production fixtures.
- Types and tool names match the technical documents.
- Selected vault manifest records official source, code hash, verification block/time, capability result.
- No service path can sign or submit.
- All `UNKNOWN` paths are tested.
- Current README/submission cites primary sources and labels inferences.

