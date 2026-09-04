---
name: tr4ce-substreams-wiring
description: Use when changing TR4CE Substreams modules, EVM ABI decoding, protobuf, Database Changes, PostgreSQL staging, promotion, or reorganization handling.
---

# TR4CE Substreams Wiring

## Scope
This skill specializes the installed official Substreams skills for the TR4CE data contract. Read `docs/technical/INTEGRATIONS.md`, `docs/technical/ARCHITECTURE.md`, `docs/technical/ERD.md`, and `docs/BUILD-PLAN.md` before changing ingestion.

## Data contract
- Use separate typed protobuf messages for `Deposit`, `Withdraw`, `ShareTransfer`, and `VaultSnapshot`; never a generic event-name/blob/JSON envelope.
- Canonical event identity is `(chain_id, block_hash, transaction_hash, log_index)`.
- Decode curated vault addresses only. Mint/burn share transfers are not economic flows unless deterministically attributed without double counting.
- Block-scoped calls return explicit per-method failures; a reverting vault cannot panic the module.

## Reorganization contract
Write mutable raw rows through `sf.substreams.sink.database.v1.DatabaseChanges` into a staging schema. The built-in PostgreSQL sink owns cursor and pre-confirmation undo. A worker promotes only confirmed rows idempotently; a detected deep reorganization marks dependent application evidence non-canonical and invalidates reports.

## Verification
Require Rust unit tests, recorded protobuf fixtures, a real bounded `substreams run`, and a bounded `substreams sink postgres` smoke run against PostgreSQL. Inspect actual emitted rows and cursor state.
