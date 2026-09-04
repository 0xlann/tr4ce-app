---
name: tr4ce-backend-wiring
description: Use when wiring TR4CE database repositories, evidence and policy services, API routes, MCP tools, chain reads, jobs, or unsigned action preparation.
---

# TR4CE Backend Wiring

## Boundary
Keep domain evidence, policy evaluation, I/O adapters, and presentation separate. The API and MCP server consume the same typed application services; neither duplicates business logic.

## Required flow
1. Resolve a curated vault identity, capability profile, and confirmed as-of block.
2. Read canonical observations from application tables plus block-pinned current chain state where required.
3. Use pure bigint/rational evidence calculations and a deterministic, versioned policy evaluator.
4. Persist an evidence report with exact observation references, reasons, units, and status.
5. For an action, construct exact ERC-4626 calldata, simulate it against the target block, return it unsigned, and reconcile a canonical receipt only after user signature.

## Engineering constraints
Validate all external input with shared schemas. Preserve transaction/idempotency records. Handle cursor replay, reorg invalidation, failed historical calls, missing capability methods, and RPC retry without creating a false positive. No LLM may make an untyped policy decision or execute a transaction.
