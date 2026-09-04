# TR4CE Foundation and Visual Direction Design

## Problem

TR4CE has a detailed product specification but no implementation workspace. It must establish one portable, typed foundation without creating a second backend, leaking credentials, or prematurely building a generic dashboard. The first product surfaces must make evidence and uncertainty legible while retaining the calm, editorial compositional quality requested by the user.

## Decision

Task 1 creates the TypeScript workspace, shared domain contract, local PostgreSQL development environment, and secret boundary. It does not build the web application, connect to Supabase, create a Supabase client, or add a database schema.

The database is PostgreSQL in every environment. Docker runs an isolated PostgreSQL 16 instance locally; Supabase provides managed PostgreSQL for shared staging and production. Both are reached through the same server-only `DATABASE_URL` value. Drizzle migrations and repositories remain portable.

## Foundation Architecture

```text
packages/domain
  -> Zod-owned, versioned value and response schemas
  -> inferred TypeScript types and exported JSON Schema
  -> consumed by evidence, policy, chain, db, API, MCP, worker, and web

Local development
  -> Docker Compose
  -> PostgreSQL 16
  -> DATABASE_URL=postgresql://tr4ce:tr4ce@localhost:5432/tr4ce

Shared deployment
  -> Supabase PostgreSQL
  -> server-only DATABASE_URL supplied by deployment secrets
```

### Domain seam

`@tr4ce/domain` is the single highest reusable seam. It validates the canonical data crossing every application boundary and produces the versioned contracts used by future packages:

- `VaultIdentity`
- `BlockRef`
- `EvidenceReportV1`
- `PolicyV1`
- `PreparedActionV1`
- `PASS | FAIL | UNKNOWN`
- stable machine-readable reason codes

Zod schemas own validation. TypeScript types are inferred from schemas. JSON boundary values use decimal strings for token amounts and block numbers; application arithmetic later uses bigint and rational calculations. Floating-point token values are invalid.

### Security boundary

- `.env.example` contains variable names and non-secret local defaults only.
- `.env` is gitignored and never committed.
- Supabase database credentials, service-role keys, and direct connection strings are never written to docs, source, `.env.example`, browser code, or chat transcripts.
- Task 1 does not need a Supabase URL, publishable/anon key, or service-role key.
- A hosted Supabase connection is set only after the exposed credentials have been rotated and inserted locally into `.env` or a deployment secret store.
- There is no private-key variable, unlimited allowance, server signing, or transaction submission path.

## Task 1 Scope

### In scope

1. Pin Node and pnpm through root workspace configuration.
2. Create the target-map directory skeleton only.
3. Add PostgreSQL 16 Docker Compose configuration with a named persistent volume and health check.
4. Add an environment example with server-only provider variables and no secrets.
5. Create `@tr4ce/domain` with identity, amount, evidence, policy, action, and reason schemas.
6. Export canonical TypeScript types and generated JSON Schema.
7. Write tests first for malformed addresses, floating-point values, unknown status values, missing report provenance, and valid report JSON round-trip.
8. Commit the independently verified foundation with the agreed Task 1 commit message.

### Explicitly deferred

- Supabase CLI installation or initialization.
- Supabase Auth, Storage, Realtime, Edge Functions, browser client, and Row-Level Security.
- Supabase remote linking, remote migration, or use of hosted credentials.
- Drizzle table definitions and migrations; these begin with the persistence task after the domain contract is established.
- Live Graph/Substreams/RPC integration.
- ERC-4626 contracts, vault addresses, and real chain data.
- Web routes, wallet SDKs, x402, MCP wiring, and agent payments.

## Local PostgreSQL Operating Guide

After Task 1 writes `docker-compose.yml`, the local database flow is:

```bash
# Start PostgreSQL in the background.
docker compose up -d postgres

# Wait for the health check to show healthy.
docker compose ps

# Diagnose startup only when a health check fails.
docker compose logs -f postgres

# Stop the local container while retaining its data volume.
docker compose down

# Delete only disposable local data and start from an empty database.
docker compose down -v
```

The developer application connects through `DATABASE_URL`. Docker is not an additional production service; it is a reproducible local PostgreSQL runtime that prevents local tests and migrations from mutating shared hosted data.

## Visual Direction

### Product-surface model

TR4CE does not default to a dashboard. It has two surface families:

```text
Persuade / orient
  Home: explain the evidence mechanism and show a live-looking illustrative trace

Operate / decide
  Compare curated vaults
  Check one address
  Read an immutable evidence report
  Prepare and confirm an action
```

The operational surfaces remain task-first, but they use an evidence dossier instead of an admin-panel layout. A persistent sidebar is not part of the initial user flow. Report navigation, history, and settings may form a later operational workspace once users have reports to manage.

### Borrowed reference principles

The visual reference is used only for composition and interaction discipline:

- sparse navigation and reduced chrome;
- one dominant scene or proof object per viewport;
- large, controlled display typography;
- generous vertical pacing between information segments;
- restrained 8px control geometry;
- progressive disclosure rather than every control visible at once;
- a purposeful transition between narrative segments;
- product proof as the main visual asset, not a grid of generic feature cards.

TR4CE preserves its supplied logo, deep-green identity, evidence-first copy, and accessibility requirements. No reference code, copy, proprietary image, logo, or brand token is copied.

### Design constraints

- Home is a persuasive editorial surface; compare, check, report, and action are operational surfaces.
- Evidence remains more prominent than return; policy verdict remains more prominent than a metric.
- `UNKNOWN` is never styled as neutral success or zero.
- Charts show exact observations, no smoothing, no unlabeled dual axes, and accessible table alternatives.
- Motion explains a state change: evidence reveal, provenance drawer, policy-to-report transition, and action-state progression. It does not animate money counters, simulate realtime financial certainty, or loop decoratively.
- The design system retains brand green and cream, semantic status colors, keyboard behavior, WCAG 2.2 AA contrast, focus states, and reduced-motion support.

### Motion tooling

Global Impeccable and Taste skills are already installed and will govern visual work. GSAP agent skills are installed in this project; the runtime `gsap` dependency remains deferred until the first approved motion implementation. GSAP use will be scoped to client interaction leaves; static layouts and data contracts stay server-friendly and dependency-light.

## Verification

Task 1 is complete only when:

1. `pnpm --filter @tr4ce/domain test` passes.
2. `pnpm --filter @tr4ce/domain typecheck` passes.
3. A valid report round-trips through JSON with explicit decimal-string boundaries.
4. Tests reject malformed addresses, floating token values, unknown enums, and reports without provenance.
5. `docker compose up -d postgres` reaches its healthy state locally.
6. `.env.example` contains no hosted credential, service role, or secret.
7. The foundation is committed as `feat(tr4ce): define domain contracts`.

## Risks and Controls

| Risk | Control |
|---|---|
| Shared hosted database is changed during development | Local Docker database is default; hosted migration is deferred and uses a server-only deployment secret. |
| JSON loses financial precision | Token/base-unit and block-number values cross JSON as validated decimal strings; no floating point. |
| A clean looking product obscures uncertainty | Policy verdict, reason codes, provenance, and limitations are first-class UI content. |
| High-craft motion harms trust or accessibility | Motion is state-bound, reduced-motion aware, and never changes meaning. |
| Generic dashboard regression | New visual work follows the editorial-operational surface split and reviewed visual reference principles. |
