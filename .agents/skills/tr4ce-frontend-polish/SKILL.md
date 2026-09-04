---
name: tr4ce-frontend-polish
description: Use when building or reviewing TR4CE evidence screens, vault comparison, policy explanations, wallet handoff, responsive layouts, accessibility, or transaction UX.
---

# TR4CE Frontend Polish

## Product truth
TR4CE presents evidence and uncertainty. It does not promise yield, safety, an optimal vault, or successful execution. Follow `docs/DESIGN-SYSTEMS.md`, `docs/PRD.md`, and `docs/technical/ARCHITECTURE.md`.

## Required states
Render distinct UI for no selected vault, loading, stale/cached evidence, insufficient history, failed read, `PASS`, `FAIL`, `UNKNOWN`, simulation in progress, simulation failure, unsigned transaction ready, wallet rejection, pending, confirmed, reverted, and receipt reconciliation failure.

## Interaction rules
- Explain each conclusion with the observed window, as-of block/time, actual return inputs, policy version, and source limitations.
- Show token amounts, decimals, asset identity, recipient, and calldata effect before wallet approval.
- Never collapse a forecast, stale value, simulation, or user signature into an executed transaction.
- Use the green/cream evidence system with text and icon status labels; preserve accessible contrast, keyboard behavior, focus, reduced motion, and narrow-screen usability.

## Verification
Drive the actual local UI after a change. Exercise the policy-to-evidence path, `UNKNOWN`, failed simulation, wallet rejection, and small viewport before declaring the flow complete.
