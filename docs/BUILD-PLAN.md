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

> **Permanently partial, by decision.** Literally proving that the third-party sink binary
> executes its own undo would need either a real Base reorg caught live — Base is a single-sequencer
> L2, so an ordinary reorg essentially does not occur under normal operation — or a local Firehose
> feeding the sink a manufactured fork, which is out of scope for this project. `substreams sink
> postgres tools` has no undo-simulation command either.
>
> `docs/technical/TECH-STACK.md`'s own testing strategy defines "sink undo" coverage as "Vitest
> against ephemeral PostgreSQL," not a live chain capture. That is exactly what
> `observations.integration.test.ts` does: promote a range, delete the unconfirmed raw rows exactly
> as a sink undo would, and re-promote to prove those rows were never touched. The test is named for
> what it proves — that promotion never reads above the confirmed head, so anything the sink is
> still entitled to undo has never reached the application tables.
>
> The remaining gap — catching the real sink binary mid-undo — depends on external chain behaviour
> outside this repo's control. The project owner reviewed this tradeoff on 2026-09-05 and chose to
> accept the item as permanently `[~]` rather than spend hackathon time chasing an event Base does
> not reliably produce. Task 3's overall acceptance clause below is met: normal reorgs are removed
> by the sink's own default, documented behaviour; replay is idempotent; a detected deep reorg
> invalidates every promoted dependent — both verified by the tests already in place.
>
> **Deviation from ERD section 6:** minimal `evidence_report`, `report_observation`, and an
> append-only `reorg_invalidation` table ship in `0001_registry_observations.sql`, because
> "invalidates every promoted dependent" cannot be demonstrated against tables that do not exist.
> Task 6 replaces both tables rather than extending them, correcting what this note originally
> predicted: ERD section 6 types `evidence_report.id` as `text` and the report id is
> `trc_<hex>`, so the primary key changes type. `0002_reports_and_policies.sql` drops and
> recreates them behind a guard that refuses to run if either holds a row — both had only ever
> been empty. `reorg_invalidation` survives unchanged apart from `subject_id` widening to
> `text`, which it needs in order to keep naming an invalidated report.

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

- [x] Write failing tests for positive/negative/zero return, round-down boundary, zero denominator, missing start, incompatible decimals, and actual elapsed window.
- [x] Implement reduced rational arithmetic and explicit basis-point rounding.
- [x] Write flow tests that exclude mint/burn transfer duplication and separate deposits from withdrawals.
- [x] Write report tests proving every value carries source references and limitations.
- [x] Add a reproducibility fixture: canonical input hash and report JSON remain stable.
- [x] Run package tests and property cases across bounded bigint ranges.
- [x] Commit as `feat(tr4ce): calculate reproducible vault evidence`.

> **Added beyond the file list:** `src/capability.ts` and `src/canonical.ts`. The manifest stores
> capability evidence as probe arrays, so reducing an array to a per-method status needs a home
> where the rule "`nonstandard_zero` becomes UNKNOWN, never FAIL" is enforced once instead of at
> each call site. `canonical.ts` holds the deterministic serialiser the report identifier hashes.
>
> **`buildEvidence` returns a draft, not an `EvidenceReportV1`.** The V1 contract requires a
> `policy` block, but policy is evaluated *against* evidence — taking an evaluation as input here
> would invert that dependency inside the signature. `attachPolicy` closes the draft once Task 5's
> evaluator has run, and parses the result against `evidenceReportV1Schema` so the published shape
> is still proven here. An incomplete draft is refused rather than filled: the V1 contract has no
> way to express "no share value", and emitting one anyway would mean inventing a number.
>
> **Deviation from ARCHITECTURE section 7:** that document describes
> `CapabilityStatus = "supported" | "nonstandard" | "reverts" | "unknown"` over a flat
> `{ maxWithdraw: CapabilityStatus, ... }` record. Neither shipped. The real contract is
> `capabilityStatusSchema` in `@tr4ce/domain` — five members, `"supported" | "reverted" |
> "nonstandard_zero" | "ambiguous" | "unsupported"` — over probe arrays, already written into
> `manifest.json` for four verified vaults and the `vault_capability.capabilities` column. The
> manifest is the event-period artifact; the document is stale, and the code follows the manifest.
>
> **ARCHITECTURE section 5's high-precision decimal library is not yet applicable.**
> `observedShareValueSchema` carries no annualized field, so `returnBps` is reachable with bigint
> rational arithmetic alone. Annualization is an optional display concern; when it arrives it must
> be isolated in this package as that section requires.

Acceptance: Missing/incompatible evidence yields structured `UNKNOWN` inputs; no `number` arithmetic touches token amounts.

## Task 5: Implement capability-aware reads and policy evaluation

**Files:**

- Create: `packages/chain/src/{abis,vault-reader,capabilities}.ts`
- Create: `packages/policy/src/{schema,compile,evaluate}.ts`
- Test: `packages/chain/src/vault-reader.fork.test.ts`
- Test: `packages/policy/src/{schema,evaluate}.test.ts`

**Produces:** Current raw reads, five-rule `PolicyV1`, per-rule decision.

- [x] Pin one fork block for each curated vault and test every required ERC-4626 method.
- [x] Preserve call value/revert and adapter interpretation separately.
- [x] Write policy-schema tests for decimal strings, five supported rules, no unknown keys, bounded windows, and valid owner address.
- [x] Implement truth table: any fail → fail; otherwise any required unknown → unknown; all pass → pass.
- [x] Add test where a documented non-standard `maxWithdraw == 0` becomes `UNKNOWN`, not `FAIL` or `PASS`.
- [x] Add optional natural-language compiler behind an interface; test invalid provider JSON never reaches evaluator.
- [x] Run policy unit and chain fork tests.
- [x] Commit as `feat(tr4ce): evaluate typed vault policy`.

> **Deviation from TECH-STACK section 9 ("Anvil/fork + viem"):** the fork tests are direct
> `eth_call`s at pinned blocks against an archival provider rather than an anvil fork. The binding
> constraint in that section is the sentence after it — "Do not mock the EVM behavior that the
> product claims to verify" — which pinned real calls satisfy, with identical values and no process
> to manage. Anvil belongs to Task 7, which needs a writable fork to simulate state-changing calls.
>
> **`packages/domain/src/policy.ts` was made strict.** `z.object` silently strips unknown keys, so
> the shipped schema would have accepted an LLM-authored policy carrying an invented operator and
> quietly discarded it. `policyRuleResultSchema` is strict for a sharper reason: it is what the
> evaluator emits, and a loose schema there would leave "a model cannot mark a rule pass" resting on
> convention rather than on the type system.
>
> **Two rules need facts the evidence draft cannot carry**, both resolved by the caller through
> `packages/chain`: the vault's deployment timestamp, without which `minimumHistory` cannot tell a
> too-young vault (FAIL) from history nobody indexed (UNKNOWN); and the owner the account reads were
> taken for, without which evidence gathered for one wallet could satisfy a rule written about
> another.
>
> **`previewDeposit`, `previewRedeem`, `maxRedeem` and `totalSupply` are read and probed but feed no
> rule.** PRD section 8.1 requires them recorded with raw outcomes; Task 7 is what consumes the
> previews. Noted so nobody hunts for a missing rule.

Acceptance: Manual typed policy works with the LLM disabled; the LLM cannot add an operator or mark a rule pass.

## Task 6: Persist immutable reports and expose the API

**Files:**

- Create: `packages/db/src/schema/{policies,reports}.ts`
- Create: `packages/db/src/repositories/{policies,reports}.ts`
- Create: `apps/api/src/routes/v1/{vaults,reports,policies,actions}.ts`
- Create: `apps/api/src/services/{evidence-service,policy-service}.ts`
- Test: `apps/api/src/routes/v1/api.integration.test.ts`

**Produces:** Versioned HTTP endpoints with OpenAPI and immutable report URLs.

- [x] Implement the remaining ERD migrations with report-observation foreign keys.
- [x] Write a test that attempts to build a report from non-canonical observations and expects rejection.
- [x] Implement `GET /v1/vaults`, `POST /v1/reports`, `GET /v1/reports/:id`, and `POST /v1/policies/evaluate`.
- [x] Make report creation idempotent on canonical input hash + versions.
- [x] Validate every request and response against shared schemas.
- [x] Generate OpenAPI and fail CI on schema drift.
- [x] Run API integration tests against a fresh database.
- [x] Commit as `feat(tr4ce): expose immutable evidence api`.

> **Report identity.** `POST /v1/reports` is idempotent because `evidence_report.id` is derived
> from the observations — `trc_` plus the first 32 hex of `canonical_input_hash`. Getting there
> required a fix: `generatedAt` was inside the hashed surface, so two requests a second apart
> produced two ids. It is no longer, and the API integration test proves the property by serving
> the two requests from apps whose clocks are twelve hours apart.
>
> **Deviation from ERD section 6:** the id is content-derived rather than "sortable generated".
> That makes "the same observations name the same report" true by construction instead of by a
> lookup before every insert. Ordering is served by `created_at` and `as_of_block_number`, both
> indexed, and `canonical_input_hash` remains a separate column with the unique index the ERD asks
> for.
>
> **A short window still produces a report.** When the requested window reaches further back than
> our index, the earliest observation we hold opens it. Refusing outright would discard evidence we
> do have; instead the report states the spacing it actually measured, adds a limitation naming the
> shortfall, and the history rule reports UNKNOWN — our coverage falling short, not the vault being
> young. Nothing is quoted over a period it was not measured over.
>
> **`actions.ts` is not built.** It appears under **Files** above, but no checklist item calls for
> it and Task 7 owns prepared and simulated actions. A stub route would have no behaviour to test.
>
> **`not_evaluated` is unreachable through this API.** The status exists because ERD section 6
> defines it, but `evidenceReportV1Schema` requires a `policy` block, so an evidence-only report has
> no wire shape to be served as. Every report this API produces carries an evaluation.

Acceptance: Repeating a request over identical inputs returns the same report; HTTP output equals the domain schema exactly. Both verified: the API integration suite counts rows in `evidence_report` rather than comparing responses, and every response is parsed through its domain schema before it is served.

## Task 7: Prepare and simulate direct ERC-4626 actions

**Files:**

- Create: `packages/chain/src/{prepare-deposit,prepare-redeem,simulate,receipts}.ts`
- Create: `packages/db/src/schema/actions.ts`
- Test: `packages/chain/src/actions.fork.test.ts`
- Test: `apps/api/src/routes/v1/actions.integration.test.ts`

**Produces:** Unsigned action arrays, bound simulation, status tracking.

- [x] Write fork tests for exact approval + deposit, redemption, wrong asset, over-balance, stale block, and changed account.
- [x] Build calls directly to verified asset/vault; refuse unlimited allowance.
- [x] Bind simulation to chain/account/to/data/value/block/capability version and expire at 3 blocks or 60 seconds.
- [x] Persist no signature; accept transaction hash only after wallet submission.
- [x] Decode receipt events and show preview-versus-actual values.
- [x] Run fork and API tests.
- [x] Commit as `feat(tr4ce): prepare simulated vault actions`.

> **Two findings the Anvil fork produced**, both now behaviour rather than surprises.
>
> The second call of an approve-plus-deposit pair cannot be simulated before the first lands — it
> reverts for want of the allowance. `nextCallToSimulate` states that, and the API simulates only
> the next unsent call: attaching a success status and a gas figure to the deposit would have
> claimed something nobody had established. Once the approval is mined the block has moved, so the
> deposit needs its own simulation anyway, which is the ordinary binding rule rather than a special
> case.
>
> On the Morpho vault `maxRedeem` sits fractionally below the owner's own share balance — about one
> part in a hundred million, from the rounding that protects the vault. A "redeem everything" button
> wired to `balanceOf` therefore builds a transaction the chain refuses. Both arms are tested.
>
> **The no-signing guarantee is checked, not asserted.** Two tests read every non-test source file
> in `packages/chain` and `apps/api` and fail if any names viem's wallet half — a wallet client
> constructed at runtime type-checks perfectly well, so types alone would not have carried the
> claim. Both were verified by introducing a submission path and watching them fail.
>
> **Deviation from the file list:** the calldata builders live in `packages/chain/src/prepare.ts`
> rather than split across `prepare-deposit.ts` and `prepare-redeem.ts`. They share every
> precondition helper and the failure type; two files would have meant one importing the other for
> no gain in navigability.
>
> **`preparedActionV1Schema` changed shape.** It held a single `unsignedTransaction`, which cannot
> express a deposit that needs an approval first. Now `transactions`, an array — matching what this
> task, the ERD, and the action console's own copy already assumed.

Acceptance: There is no service method that signs or submits; changing any bound field makes the action non-signable until resimulation. Both verified: the source-level checks above cover the first, and `checkSignable` is exercised by mutating each of the eight bound fields on its own — an aggregate check would pass while seven went unbound.

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

