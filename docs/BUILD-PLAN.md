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
> task, the ERD, and the action console's own copy already assumed. Each entry carries its `kind`,
> and the schema also carries `previewed`.
>
> ---
>
> **The first cut of this task shipped a flow that could not be completed.** Found by running the
> approve-then-deposit sequence through the routes rather than through the chain: reporting the
> approval's hash moved the action to `submitted`, and the deposit then had nowhere to go — it could
> not be simulated, its hash could not be reported, and `transaction_receipt` had room for one row
> per action. The fork test passed throughout, because it drives the chain directly and never asks
> the API to represent the pair.
>
> The cause was one decision: the block was part of the action's identity. `calldata_hash` and the
> `act_` id were both derived from the *simulation* binding, which is pinned to a block. ERD section
> 7 puts `calldata_hash` on `prepared_action` and `block_number` on `simulation`, and this is why.
>
> What changed:
>
> - `actionDigest` covers chain, account, every call in signing order, and capability version —
>   never the block. `bindingDigest` still covers one simulation, block included.
> - **The action id is generated, not derived.** A report is a pure function of its observations, so
>   naming it after them is right; an action is an intent to spend, and repeating one is legitimate.
>   TR4CE's approval is exact, so a completed deposit leaves the allowance at zero and an identical
>   second deposit is a second real action — under a content-derived id it would have been
>   unpreparable forever. Idempotency moved to a partial unique index on `calldata_hash` covering
>   only actions still awaiting signature, which is where it means something.
> - `sent_count`, `previewed_amount` and `capability_version` on `prepared_action`; `call_index` on
>   `simulation`; `call_index` and `actual_amount` on `transaction_receipt`. A CHECK refuses
>   `submitted` while any call still lacks a hash.
> - `report_id` became a composite foreign key to `(id, vault_id)`. It was a plain reference, so an
>   action on one vault could cite a report about another — the bug `report_observation`'s own
>   composite keys exist to prevent.
> - **`POST /v1/actions/{id}/simulate`.** The acceptance clause says an action is non-signable
>   *"until resimulation"*, and there was no resimulation path at all. It is also the only way the
>   deposit of a pair is ever simulated.
> - `GET /v1/actions/{id}` refuses to call an action signable when the newest simulation is for a
>   different call than the one awaiting signature. Without that, a wallet could sign a deposit on
>   an approval's gas estimate (TR-F-032). Verified by removing the check and watching the flow test
>   fail.
>
> **Second deviation from ERD section 7:** `transaction_receipt` is keyed `(prepared_action_id,
> call_index)`, where the ERD writes `prepared_action_id` UNIQUE. One receipt per action cannot
> represent the approve-plus-deposit pair SMART-CONTRACT.md section 4 requires — the approval's hash
> would overwrite the deposit's or have nowhere to go. Recorded here rather than left as an
> undocumented difference, on the same terms as the content-derived report id in Task 6.
>
> **`invalidateAction` has no caller in this task.** It is the write side of the reorg path, which
> `reorg_invalidation.subject_id` became TEXT for in Task 6. It is kept and tested rather than given
> an invented caller: an expired budget is *not* a reason to write `expired`, because resimulating
> revives the action and a terminal status would be a lie about that.

Acceptance: There is no service method that signs or submits; changing any bound field makes the action non-signable until resimulation. Both verified: the source-level checks above cover the first, and `checkSignable` is exercised by mutating each of the eight bound fields on its own — an aggregate check would pass while seven went unbound.

## Task 8: Expose MCP tools and public agent skill

**Files:**

- Create: `apps/mcp/src/{server,tools}.ts`
- Create: `skill/SKILL.md`
- Create: `evals/{prompts.jsonl,rubric.json}`
- Test: `apps/mcp/src/tools.protocol.test.ts`

- [x] Register exactly six tools from the integrations specification.
- [x] Reuse application services and Zod-generated schemas; do not duplicate calculations.
- [x] Assert prepare tools return unsigned data and no submit method exists.
- [x] Document units, limitations, freshness, errors, and wallet approval in `SKILL.md`.
- [x] Test HTTP report JSON and MCP report JSON for canonical equality.
- [x] Commit as `feat(tr4ce): add typed agent evidence tools`.

Acceptance: An MCP client can discover, evaluate, and prepare without unrestricted GraphQL or transaction submission.

> **The tools dispatch into the Hono app in process, rather than calling services one by one.**
> Two things forced it, and both are worth stating because the checklist says "do not duplicate
> calculations" without saying where the duplication would come from.
>
> `POST /v1/policies/evaluate` orchestrates `validatePolicy` → `requireVault` → `buildDraft` →
> `evaluatePolicy` inside its route handler; there is no `policy-service.ts`. And the structured
> error envelope is applied by `app.onError`. A tool layer calling services directly would have to
> reimplement both. Going through the routes means there is no second implementation at all, which
> makes "MCP and UI return the same report schema" (PRD section 13, step 7) structural.
>
> **`@tr4ce/api` gained an `exports` map**, so it is now an app that is also a library. The tidier
> shape — lifting the services *and* the route orchestration into a package of their own — would not
> change a line of what the tools do, and is noted in `apps/api/src/index.ts` as the thing to do
> later rather than left implicit.
>
> **What "side effect: None" means in INTEGRATIONS section 7.** It cannot mean "writes nothing":
> `prepare_deposit` persists a prepared action and its simulation, and `get_evidence` persists a
> report. It means no chain state changes and no funds move. That reading is written into
> `SKILL.md`, along with its consequence — these tools are never described as read-only, because
> two of them write.
>
> **stdio only.** A streamable-HTTP transport is Task 10's deployment item; adding it here would be
> configuration that the in-memory protocol tests do not exercise either way. The server refuses to
> start without `RPC_URL_BASE`: three of the six tools need a chain, and without one the action
> routes answer 501 — half the advertised surface failing on use rather than at startup.
>
> **A control that did not fail, reported rather than quietly dropped.** The plan said to prove the
> byte-equality test by replacing the response pass-through with
> `JSON.stringify(await response.json())`. The suite stayed green: for the shapes this contract
> carries, a round trip produces identical bytes — every large number is already a decimal string
> and no key is integer-like. The test does catch reshaping and reformatting (both verified by
> breaking them), and the pass-through is kept because it is byte-identical for *any* payload rather
> than only for today's. The comment in `respond()` says exactly that instead of claiming a risk
> that does not exist here.
>
> **A product gap the prompt set surfaced, left open deliberately.** `get_evidence` requires a full
> five-rule policy, because `evidenceReportV1Schema.policy` is a required block of the v1 report
> contract. So the most natural agent question — "what did this vault do over the last week?" —
> cannot be answered without the user supplying criteria, and an agent that invents thresholds
> produces a `status` verdict about numbers nobody asked for.
>
> Closing it means making the policy evaluation optional in a published contract: a schema-version
> bump, a change to what `canonical_input_hash` covers and therefore to report identity, and a change
> to the OpenAPI document and the web report page. That is Task 6's contract, not Task 8's, and doing
> it here would silently re-identify every stored report. The storage layer is already ready —
> migration 0002's `evidence_report_policy_status_check` allows a null `policy_version_id` paired
> with `status = 'not_evaluated'` — so the work is in the contract, not the database.
>
> For now the constraint is stated in `SKILL.md` with the instruction to ask for criteria rather than
> invent them, and the affected eval prompt states its criteria.
>
> `evals/prompts.jsonl` and `evals/rubric.json` are the fixed prompt set and scoring only. Running
> them is Task 10.

## Task 9: Build the evidence-first web product

**Files:**

- Create routes under `apps/web/app/{search,reports/[id],actions/[id],evals}`
- Create components under `apps/web/components/{evidence,policy,provenance,actions}`
- Create: `apps/web/styles/tokens.css`
- Test: `apps/web/e2e/tr4ce.spec.ts`

- [x] Implement design tokens from `DESIGN-SYSTEMS.md` and verify AA contrast.
- [x] Build disconnected search and typed policy builder first.
- [x] Build comparison with `PASS/FAIL/UNKNOWN`, completeness, and as-of block.
- [x] Build report calculation/provenance disclosure and JSON view.
- [ ] Add wagmi action flow with chain/account invalidation and exact wallet preview.
- [x] Add loading, stale, partial, reorged, simulation-failed, submitted, confirmed, and reverted states.
- [x] Write Playwright path: policy → mixed results → report → simulation → mocked wallet handoff; use fork test for real EVM behavior.
- [x] Test keyboard-only flow and mobile evidence parity.
- [x] Commit as `feat(tr4ce): ship evidence-first interface`.

Acceptance: A user can explain a failed/unknown rule and inspect exact provenance without a wallet; no APY headline outranks policy status.

> **The visual product already existed; the data did not.** Every route and component was built
> against `src/demo/fixtures.ts`, deliberately — the Task 9 design spec says so and names the seam:
> *"When Task 6 exists, a single fixture-provider module is replaced with HTTP reads."* This task is
> that replacement. It turned out to be three places rather than one: both dynamic routes enumerated
> fixture ids through `generateStaticParams`, and the comparison surface computed its results
> synchronously in the browser. `generateStaticParams` is gone from both — a `trc_` id is a digest of
> observations and an `act_` id is generated, so neither set is knowable at build time.
>
> **The browser never talks to the evidence API.** Every call goes through a route handler under
> `app/api`. Not for CORS — the API mounts none — but because it has no authentication at all:
> reaching it from the browser means reaching it from anyone, and every visitor could then write
> reports into the database. `TR4CE_API_URL` stays server-side.
>
> **The policy builder posts to the endpoint that was built for it.** `POST /v1/policies/evaluate`
> takes `policy: z.unknown()` and answers with issues rather than a rejection (TR-F-024), so the
> browser holds no second copy of the rules. Three read-only presets and a dead "Use this policy"
> button became six editable fields with issues rendered beside them.
>
> **Four defects the work surfaced, all fixed:**
>
> - `evaluatePolicy` answers **422** with the *ordinary* response body carrying `issues`, not the
>   error envelope. The first client treated any non-2xx as a failure and discarded them, so an
>   invalid draft produced "something went wrong" and no indication of what.
> - The evaluator reports issue paths relative to the policy (`minHistoryDays`), not to the request
>   that carried it. A `policy.` prefix meant no issue ever matched a field, and the panel looked
>   correct while showing none.
> - `ScrollMotion`'s fail-safe restored `opacity` after 2.5s, but `autoAlpha: 0` hides through
>   `visibility: hidden`. The safety net that exists so nothing stays invisible when a scroll trigger
>   never fires did nothing at all. Found at 390px, where the content below the fold is exactly what
>   a phone reader must scroll to.
> - `--shadow-lift` in `globals.css` reads `rgb(19 34 26 / 5 0%)` — a space inside the number makes
>   the whole declaration invalid. Left as-is and reported rather than silently changed: it is a
>   visual decision on someone else's palette.
>
> **Tokens moved, colours did not.** `styles/tokens.css` holds the palette exactly as shipped.
> `DESIGN-SYSTEMS.md` section 3 named a different one (`--tr4ce-brand-500`) that was never
> implemented; the design spec's own completion criteria say the document should reflect the
> implemented system, so the document was brought into line rather than the interface repainted.
> AA contrast is verified by `scripts/check-contrast.mjs`, which reads the token values and the
> `color:`/`background:` pairs out of every stylesheet: **33 co-located pairs, all clearing 4.5:1.**
> The script reports only pairs that certainly meet — a colour whose background comes from an
> ancestor is checked by reading the component, and the script says so.
>
> **Playwright is not in `pnpm test`.** It needs a database, the API and a web server, and turbo runs
> `test` everywhere; a 114 MB browser download is not a condition of checking out this repo. Run
> `pnpm --filter @tr4ce/web e2e`. Twelve tests pass across a desktop and a 390px viewport, the two
> skips being deliberate (keyboard is a desktop path, column parity a mobile one).
>
> **The wallet flow is not in this commit.** The acceptance clause is explicitly *"without a
> wallet"*, and the read-only half is complete and provable on its own. `apps/web` still pins
> TypeScript 5.7.3 against the root's 7.0.2, which is most likely to bite when wagmi's types arrive —
> that must not hold up a finished path. The checklist item stays unticked until it ships.
>
> **`/actions/[id]` still renders the illustrative fixture.** It is the wallet page: its data comes
> from `POST /v1/actions/prepare`, which needs an owner address. There is also a real API gap for the
> second commit to close — `GET /v1/actions/:id` returns status only, with no calldata, so a user
> reloading a prepared action cannot see the transactions again.

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

