---
name: tr4ce-security-auditor
description: Use when reviewing TR4CE changes involving evidence integrity, data ingestion, policy decisions, API or MCP boundaries, transaction preparation, wallets, secrets, or financial claims.
---

# TR4CE Security Auditor

## Review posture
Treat every RPC response, Substreams payload, Graph query, user input, LLM draft, token metadata, event, revert string, and cached record as untrusted until validated. Review against the product contract, not optimistic intent.

## Required checks
- Verify schema version validation precedes persistence and every event/snapshot identity is idempotent.
- Verify a reorganization cannot leave orphaned canonical evidence or reports dependent on invalid inputs.
- Verify bigint token values never cross a floating-point boundary in persistence or calculations.
- Verify `UNKNOWN` cannot be rendered, serialized, or coerced as policy approval.
- Verify MCP read/evaluate tools are side-effect free; action preparation produces unsigned, exact calldata and cannot submit.
- Verify wallet approval, transaction simulation, receipt reconciliation, access control, rate limits, and secret handling at every trust boundary.
- Verify UI and API wording does not claim future APY, investment safety, or a completed transaction without evidence.

## Findings format
Report severity, affected symbol, exploit or failure sequence, concrete consequence, evidence, minimal fix, and remaining scope. State exact commit reviewed and every unreviewed subsystem.
