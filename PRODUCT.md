# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Existing architecture: Next.js web application, Hono API, MCP server, TypeScript domain packages, PostgreSQL/Drizzle, Rust Substreams, and direct wallet interactions through viem/wagmi. Local development uses Docker PostgreSQL; shared deployment uses Supabase PostgreSQL through the same server-only `DATABASE_URL`.

## Users
- Treasury operators comparing curated USDC-denominated ERC-4626 vaults before proposing an allocation that another signer can review.
- Agent developers who need typed evidence, explicit uncertainty, and unsigned actions without granting agents custody.
- DeFi researchers who need reproducible block-level observations, formulas, and provenance.

## Product Purpose
TR4CE gives people and agents reproducible evidence of what an ERC-4626 vault actually did, evaluates that evidence against an explicit typed policy, and prepares a transaction that the connected wallet owner must explicitly approve. Success means a user can understand, reproduce, and act on a vault decision without mistaking historical evidence for a safety or yield guarantee.

## Positioning
TR4CE turns standardized ERC-4626 data into an immutable evidence report: every policy verdict cites exact observations, formula inputs, source type, schema version, and as-of block. It fails closed when evidence is missing or ambiguous, and it never takes custody or submits transactions.

## Operating Context
A treasury operator or agent starts by comparing a curated set of USDC vaults or checking one supported vault address. Both entry points use one typed five-rule policy and one deterministic evidence engine. The system consumes live The Graph/Substreams data and block-pinned chain reads, exposes the same versioned report through web and MCP surfaces, and may charge agents for hosted evidence services through x402 after the evidence pipeline is proven.

## Capabilities and Constraints
- MVP supports only verified USDC-denominated ERC-4626 vaults.
- Every required policy rule returns `PASS`, `FAIL`, or `UNKNOWN`; missing, stale, incompatible, or reverted evidence is `UNKNOWN`.
- The five policy rules cover underlying asset, minimum history, TVL, observed share-value return, and connected-account withdrawable assets.
- “Observed share-value return” is backward-looking share-conversion evidence, not realized user P&L, a forecast, or a safety claim.
- The product has two entry points—compare curated vaults and check one vault address—but one deterministic evidence and policy engine.
- Unsupported addresses receive diagnostics only; TR4CE does not fabricate a score, report, or action path.
- Services never ingest private keys, request unlimited allowance, sign transactions, or submit transactions.
- No TR4CE smart contract, token, autonomous custody, universal risk score, cross-chain action execution, or multi-asset comparison belongs in the MVP.
- Local PostgreSQL runs in Docker for isolated development and tests. Supabase is a managed PostgreSQL deployment target only; Supabase Auth, Storage, Realtime, Edge Functions, and browser client keys are not part of Task 1.

## Brand Commitments
TR4CE is uppercase in brand contexts. The supplied `tr4ce-logo.png` is the canonical mark and must not be redrawn, recolored, cropped, stretched, rotated, or shadowed. The visual language is botanical but precise, evidence-first, calm, and technical. The user wants a high-craft editorial product experience inspired by the compositional discipline, restrained chrome, generous whitespace, large type, and deliberate motion of rothfinder.com, while preserving TR4CE’s own deep-green and cream identity. The product must not look like a generic AI dashboard, a casino, or a neon crypto interface.

## Evidence on Hand
- Product requirements: `docs/PRD.md`
- Architecture: `docs/technical/ARCHITECTURE.md`
- Data model: `docs/technical/ERD.md`
- Installation contract: `docs/technical/INSTALLATION.md`
- Existing design system: `docs/DESIGN-SYSTEMS.md`
- Build plan: `docs/BUILD-PLAN.md`
- Canonical brand asset: `tr4ce-logo.png`
- Visual reference reviewed: https://rothfinder.com/
- No verified production vault data, live provider result, real transaction, or customer claim exists yet and must not be fabricated.

## Product Principles
1. Evidence before recommendation.
2. Explicit policy before evaluation.
3. Unknown fails closed.
4. The human or wallet owner retains signing authority.
5. High-craft presentation must make uncertainty and provenance easier to understand, not obscure them.

## Accessibility & Inclusion
The web interface requires WCAG 2.2 AA contrast, full keyboard operation, visible focus states, text/icon/reason status treatment, reduced-motion support, accessible full addresses, and chart table alternatives. Wallet connection is never required for read-only evidence exploration.
