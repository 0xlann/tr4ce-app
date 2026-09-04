# TR4CE Technology Stack

## 1. Decision summary

| Layer | Choice | Why |
|---|---|---|
| Workspace | pnpm workspaces + Turborepo | Shared typed packages and bounded build graph; no custom tooling |
| Web | Next.js App Router + React + TypeScript | Server/client boundaries, routing, deployment, ecosystem |
| UI | Tailwind CSS + Radix primitives | Fast accessible composition without a full visual framework |
| Wallet | wagmi + viem | Typed EVM reads, simulation, wallet state |
| API | Hono on Node runtime | Small typed HTTP boundary usable independently of Next.js |
| Validation | Zod + generated JSON Schema | Runtime trust-boundary validation and MCP/API schemas |
| Data | PostgreSQL + Drizzle ORM | Relational provenance, migrations, bigint-safe string decoding |
| Indexing | Rust/WASM Substreams + protobuf | Primary hackathon integration and reusable data product |
| Sink | Built-in `substreams sink postgres` + Database Changes | Reorg-aware raw staging before confirmed promotion |
| MCP | official TypeScript MCP SDK | Typed agent tools over the same application services |
| Math | native `bigint` + one decimal library for annualization display | Exact token units; isolated non-integer operation |
| Tests | Vitest, Playwright, Foundry fork tests only if Solidity harnesses help | Layer-appropriate observable checks |
| Observability | OpenTelemetry-compatible structured logs/metrics | Portable evidence and latency diagnostics |
| Local infra | Docker Compose for PostgreSQL only | One stateful dependency |

Versions are pinned in the lockfile at scaffold time. Do not place floating `latest` tags in CI or deployment.

## 2. Repository layout

```text
tr4ce/
├─ apps/
│  ├─ web/                 # Next.js product UI
│  ├─ api/                 # Hono HTTP API
│  ├─ mcp/                 # MCP stdio/HTTP transport
│  └─ worker/              # refresh, sink, reorg invalidation
├─ packages/
│  ├─ contracts/           # verified ABIs and generated viem types
│  ├─ domain/              # shared branded IDs and enums
│  ├─ evidence/            # pure calculations/report builder
│  ├─ policy/              # schema/compiler/evaluator
│  ├─ chain/               # RPC reads, calldata, simulation
│  ├─ db/                  # Drizzle schema/migrations/queries
│  └─ test-vaults/         # event-period curated manifest
├─ substreams/
│  └─ erc4626/             # Rust modules, protobuf, fixtures
├─ evals/                  # prompts, rubric, raw/canonical results
├─ skill/
│  └─ SKILL.md             # agent usage contract
├─ docker-compose.yml
├─ pnpm-workspace.yaml
└─ turbo.json
```

Avoid a generic `utils` package. Code belongs with the domain that owns its invariant.

## 3. Runtime baseline

- Node.js: active LTS, minimum 22; pin exact version in `.nvmrc`/Volta.
- pnpm: project-pinned through Corepack and `packageManager`.
- Rust: stable, pinned with `rust-toolchain.toml`.
- WASM target required by Substreams toolchain.
- PostgreSQL: 16 or newer.
- Docker Desktop/Engine: local database only.

## 4. Type and unit strategy

```ts
type ChainId = number & { readonly __brand: "ChainId" };
type Address = `0x${string}`;
type BaseUnits = bigint & { readonly __brand: "BaseUnits" };
type BlockNumber = bigint & { readonly __brand: "BlockNumber" };
type BasisPoints = number & { readonly __brand: "BasisPoints" };
```

- viem supplies canonical address/hash types at EVM boundaries.
- API/MCP encode big integers as decimal strings.
- PostgreSQL `numeric` decodes to string; convert explicitly to `bigint`.
- UI formatting receives `{ value, decimals, symbol }`; no global implicit decimals.
- Financial policy decisions cannot use `number` except bounded integer basis points after exact conversion.

## 5. Why these choices

### Next.js, not a separate SPA plus BFF

The app needs routes, server-rendered evidence pages, wallet client components, and shareable report URLs. Next.js covers those. The Hono API remains a small independent process because MCP and workers need the same typed service without importing UI route handlers.

### PostgreSQL, not document storage

Provenance is relational: reports cite exact observations, policies cite rules, actions cite simulations. Foreign keys and transactions prevent orphaned evidence. JSONB is retained only for versioned response bodies and typed observations.

### Rust only where required

Rust powers the Substreams package. Evidence and policy logic stay in TypeScript so web, API, MCP, and tests share one implementation. Do not rewrite the same financial formula in Rust and TypeScript unless the Substreams output itself requires it.

### No custom contract

Direct ERC-4626 calls are the simplest trustworthy action path. See [SMART-CONTRACT](./SMART-CONTRACT.md).

## 6. Package-level interfaces

### `@tr4ce/evidence`

```ts
export function buildEvidence(input: EvidenceInput): EvidenceReport;
export function observedShareValueReturn(
  startAssets: bigint,
  endAssets: bigint,
): RationalResult;
export function aggregateFlows(flows: readonly VaultFlow[]): FlowAggregate;
```

No I/O imports.

### `@tr4ce/policy`

```ts
export const policySchema: z.ZodType<PolicyV1>;
export function evaluatePolicy(
  policy: PolicyV1,
  evidence: EvidenceReport,
): PolicyEvaluation;
```

### `@tr4ce/chain`

```ts
export interface VaultReader {
  readSnapshot(input: ReadSnapshotInput): Promise<RpcVaultObservation>;
  prepareDeposit(input: PrepareDepositInput): Promise<PreparedAction>;
  prepareRedeem(input: PrepareRedeemInput): Promise<PreparedAction>;
}
```

### `@tr4ce/db`

Repository functions return domain objects, not raw Drizzle rows. Mutation functions require an explicit transaction when observation/cursor or report/refs must commit atomically.

## 7. UI stack rules

- Tailwind consumes CSS variables from [DESIGN-SYSTEMS](../DESIGN-SYSTEMS.md).
- Radix supplies behavior for dialog, tooltip, tabs, and disclosure; TR4CE owns styling.
- Use native table semantics before virtualized grids. Add virtualization only after measured need.
- Recharts/D3 is not installed initially. Use lightweight SVG/HTML for two simple charts; add a chart library only if interaction requirements justify it.
- Wallet code is isolated in client components; evidence pages remain renderable without JavaScript where practical.

## 8. API and MCP schemas

One Zod schema owns each request/response. Generate:

- OpenAPI for HTTP documentation;
- JSON Schema for policy and MCP tool input;
- TypeScript inferred types.

Do not maintain handwritten copies. Response version is explicit and breaking schema changes require a new major route/tool version.

## 9. Testing stack

| Contract | Tool | Examples |
|---|---|---|
| Pure math/policy | Vitest + property-based cases where valuable | zero denominator, rounding, unknown propagation |
| Substreams | `substreams::testing::map!`, real-block fixtures, CLI golden JSONL | typed event decoding, mint/burn exclusion, failed block call |
| Database | Vitest against ephemeral PostgreSQL | sink undo, confirmed promotion, deep-reorg invalidation, FK integrity |
| RPC integration | Anvil/fork + viem | selected vault reads and action simulation |
| API/MCP | In-process protocol tests | schema equality, side-effect-free prepare tools |
| Web | Playwright | policy → evidence → simulation → wallet handoff |

Do not mock the EVM behavior that the product claims to verify; use pinned fork tests.

## 10. Deployment topology

Hackathon deployment:

```text
Web/API/MCP (2 processes or one platform)
Worker (single process)
Managed PostgreSQL
The Graph provider
EVM RPC provider
```

- Stateless units use immutable images/builds.
- One migration job runs before app rollout.
- Worker replica count remains one until job locking is implemented.
- Provider secrets are environment-scoped and never exposed through `NEXT_PUBLIC_*`.

## 11. Rejected choices

| Rejected | Reason |
|---|---|
| Microservices/Kafka | No scale evidence; slows a short build |
| GraphQL app API | Internal product surface is small; HTTP/MCP schemas suffice |
| Redis | PostgreSQL and one worker cover MVP coordination |
| Floating-point ORM columns | Unsafe for token units |
| Custom universal vault adapter DSL | Three curated adapters do not justify it |
| Python evidence service | Duplicates types and deployment for no measured benefit |
| Autonomous signer | Violates custody and approval model |
| Stylus/Solidity contract | No load-bearing contract requirement in TR4CE MVP |

## 12. Dependency policy

- Prefer platform/standard-library features.
- Every runtime dependency needs one named responsibility.
- Pin package-manager and lockfile; automated updates open reviewed changes.
- Run license and vulnerability checks in CI.
- Never install a package solely for one trivial formatter/helper.
- Generated contract/protobuf clients are committed only if generation is deterministic and CI verifies drift.
