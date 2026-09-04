# TR4CE Installation and Development Enablement

This document separates **tools needed to build TR4CE** from **agent skills that improve the workflow**. Agent skills do not become runtime dependencies.

## 1. Current repository audit

Verified in `.agents/skills/` on 1 September 2026:

- 55 project-local `SKILL.md` files are present.
- Superpowers workflow skills are installed, including `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, and `subagent-driven-development`.
- Matt Pocock workflow skills are installed, including `research`, `domain-modeling`, `codebase-design`, `tdd`, `code-review`, `setup-ts-deep-modules`, `to-spec`, and `to-tickets`.
- The installed files are readable from `.agents/skills/`. A running agent’s built-in skill registry may not hot-reload newly installed project skills; start a fresh compatible session or read the project file directly.
- Official StreamingFast skills `substreams-dev`, `substreams-ethereum`, `substreams-sql`, and `substreams-testing` are installed from `streamingfast/substreams-skills`.

Do not reinstall the two existing skill collections. Reinstallation adds noise and may overwrite local links without improving the product.

## 2. Recommended workflow skills

| Development stage | Installed skill | Use |
|---|---|---|
| Product change | `brainstorming` | Confirm user, scope, alternatives, and design before code |
| External facts | `research` | Verify against official docs/source and capture citations |
| Domain contract | `domain-modeling` | Keep vault/evidence/policy vocabulary precise |
| Architecture | `codebase-design` | Preserve deep module boundaries |
| Plan | `writing-plans` | Produce testable implementation tasks |
| Implementation | `test-driven-development` / `tdd` | Red-green slices around observable contracts |
| Failures | `systematic-debugging` | Root-cause investigation before patching |
| Completion | `verification-before-completion` | Run fresh proof before claiming done |
| Review | `requesting-code-review` / `code-review` | Spec and standards review |

## 3. Official Substreams skills

The four required skills are installed in this repository. Use these commands only to inspect the source or reproduce installation in a fresh implementation repository:

```bash
npx --yes skills@latest add streamingfast/substreams-skills --list
npx --yes skills@latest add streamingfast/substreams-skills --skill substreams-dev
npx --yes skills@latest add streamingfast/substreams-skills --skill substreams-ethereum
npx --yes skills@latest add streamingfast/substreams-skills --skill substreams-sql
npx --yes skills@latest add streamingfast/substreams-skills --skill substreams-testing
```

If the community installer cannot target those skill names, follow the official repository’s current installation method instead of guessing flags:

- [The Graph Substreams Skills documentation](https://thegraph.com/docs/en/substreams/tooling/skills/)
- [StreamingFast Substreams Skills repository](https://github.com/streamingfast/substreams-skills)

Required subset:

- `substreams-dev`: package discovery and module composition;
- `substreams-ethereum`: EVM ABI/event/call handling;
- `substreams-sql`: sink schema and mapping;
- `substreams-testing`: fixtures and deterministic tests.

Do not install every chain-specific skill.

## 4. Workstation prerequisites

Install and verify:

```bash
node --version
corepack --version
rustc --version
cargo --version
docker --version
git --version
```

Baseline:

- Node.js active LTS, minimum 22;
- Corepack-enabled pnpm pinned by the repository;
- Rust stable pinned by `rust-toolchain.toml`;
- Docker for PostgreSQL;
- Git;
- Substreams CLI version pinned in the project bootstrap/CI.

Install the WASM target after reading the pinned toolchain:

```bash
rustup target add wasm32-unknown-unknown
```

Install the Substreams CLI using the official current instructions for the host OS:

- [Substreams installation](https://docs.substreams.dev/how-to-guides/installing-the-cli)

The official guide currently targets Linux/macOS. On this Windows workstation, run Substreams inside WSL2 or a Linux Dev Container and pin that environment in the repository; do not assume a native Windows binary.

Do not copy an unverified binary into the repository.

## 5. Project bootstrap

Commands below assume the future implementation root is `tr4ce/`, not this documentation directory.

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:migrate
pnpm generate
pnpm verify
```

`pnpm verify` is the canonical local gate and should run, in order:

1. formatting check;
2. lint;
3. TypeScript build/typecheck;
4. Rust format/lint/test;
5. unit/integration tests;
6. generated-schema drift check.

A first clone uses the committed lockfile. Dependency updates are a separate reviewed operation.

## 6. Environment contract

Commit `.env.example`; never commit `.env`.

```dotenv
# Public network identity only
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=

# Server-only providers
DATABASE_URL=postgresql://tr4ce:tr4ce@localhost:5432/tr4ce
GRAPH_SUBSTREAMS_ENDPOINT=
GRAPH_API_KEY=
RPC_URL_ETHEREUM=
RPC_URL_BASE=

# Optional policy-draft provider; app works without it
POLICY_LLM_PROVIDER=disabled
POLICY_LLM_API_KEY=

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=
LOG_LEVEL=info
```

Rules:

- RPC and Graph credentials are server-only.
- Do not prefix secrets with `NEXT_PUBLIC_`.
- There is no private-key variable.
- Tests use disposable/fork accounts supplied by Anvil, not production secrets.
- Vault addresses live in a reviewed manifest, not environment variables.

## 7. Local services

Minimal `docker-compose.yml` contains PostgreSQL only.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: tr4ce
      POSTGRES_PASSWORD: tr4ce
      POSTGRES_DB: tr4ce
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tr4ce"]
      interval: 2s
      timeout: 2s
      retries: 20
    volumes:
      - tr4ce-postgres:/var/lib/postgresql/data
volumes:
  tr4ce-postgres:
```

No Redis, message broker, or local blockchain is permanently required. Fork tests start and stop Anvil themselves.

## 8. Substreams development setup

From `substreams/erc4626`:

```bash
substreams build
cargo test
substreams run \
  -e mainnet.eth.streamingfast.io:443 \
  substreams.yaml \
  map_vault_block_batch \
  --start-block <verified-start-block> \
  --stop-block +100 \
  -o jsonl

substreams sink postgres setup substreams.yaml --dsn \"$DATABASE_URL\"
substreams sink postgres substreams.yaml \
  --dsn \"$DATABASE_URL\" \
  --start-block <verified-start-block> \
  --stop-block +100 \
  --batch-block-flush-interval=1
```

`<verified-start-block>` is deliberately supplied by the selected-vault manifest at implementation time; do not paste an invented block into the canonical guide.

The manifest pins `sink.module: db_out`, whose output type is `sf.substreams.sink.database.v1.DatabaseChanges`. The bounded sink command uses a one-block flush interval so a short smoke range actually reaches PostgreSQL.

Before writing a package:

1. search [substreams.dev](https://substreams.dev/) for compatible modules;
2. record package/version and reuse decision;
3. inspect protobuf and module graph;
4. extend rather than fork when the contract is compatible;
5. pin package hashes/versions.

## 9. Database setup

```bash
pnpm --filter @tr4ce/db db:generate
pnpm --filter @tr4ce/db db:migrate
pnpm --filter @tr4ce/db test
```

Migrations are append-only after deployment. Generated SQL is reviewed. A migration that changes units, address encoding, report immutability, or canonical keys requires an architecture review.

## 10. Wallet and fork setup

Use Anvil with a pinned fork block:

```bash
anvil --fork-url "$RPC_URL_ETHEREUM" --fork-block-number <verified-block>
```

Tests impersonate/fund disposable local accounts. Never request a user seed phrase. The UI supports disconnected read-only exploration.

## 11. CI installation order

```text
checkout
→ verify pinned Node/pnpm/Rust/Substreams versions
→ pnpm install --frozen-lockfile
→ cache cargo registry/build by lockfile
→ start PostgreSQL service
→ apply migrations
→ generate schemas/types
→ reject generated drift
→ run verify
→ build immutable artifacts
```

Fork/provider tests use explicit secrets and are separated from deterministic unit tests. A missing external secret should skip only the clearly labeled external job, not turn the whole suite green.

## 12. Security checks

Required before deployment:

- dependency vulnerability and license scan;
- secret scan;
- CSP and public-environment review;
- generated ABI/protobuf diff review;
- selected-vault address/code-hash verification;
- exact-allowance invariant test;
- no signing/private-key code path in services;
- provider timeouts and rate limits;
- backup/restore smoke test for PostgreSQL.

## 13. Do not install yet

- Redis/Kafka: no queue scale requirement.
- A full design-system framework: Tailwind + accessible primitives are enough.
- A custom indexer database: PostgreSQL sink is enough.
- Solidity/Stylus toolchain for production contracts: TR4CE MVP has no custom contract.
- Multiple LLM SDKs: one optional provider adapter, only after manual policy input works.
- Browser extension tooling: web + MCP provides the useful surfaces.

Add any of these only after a measured requirement and an update to [TECH-STACK](./TECH-STACK.md).
