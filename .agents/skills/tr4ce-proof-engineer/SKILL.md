---
name: tr4ce-proof-engineer
description: Use when qualifying a TR4CE vault, computing evidence, evaluating policy, presenting observed return, or deciding whether a claim is supportable.
---

# TR4CE Proof Engineer

## Mission
Produce a reproducible evidence record for an ERC-4626 vault. Do not turn advertised APY, a current share price, or a model prediction into realized return.

## Required evidence chain
1. Read `docs/PRD.md`, `docs/technical/ARCHITECTURE.md`, `docs/technical/INTEGRATIONS.md`, and `docs/technical/ERD.md`.
2. Pin chain ID, vault/asset address, block number/hash/time, schema version, capability profile, and source provenance.
3. Validate raw token units and ERC-4626 semantics before calculation; use integer/rational arithmetic and name every denominator.
4. Select only an as-of block at or below the configured confirmation depth.
5. Preserve `PASS`, `FAIL`, and `UNKNOWN`. Missing history, incompatible schema, failed calls, or insufficient evidence is `UNKNOWN`, never a pass.

## Reporting rule
Label data `LIVE`, `FORKED`, `SIMULATED`, `CACHED`, or `ILLUSTRATIVE`. State observed window, actual elapsed seconds, start/end values, relevant flows, exclusions, policy version, and limitations. The result is decision support, not an investment promise or custody instruction.
