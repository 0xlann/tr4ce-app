-- TR4CE application schema: registry, confirmed observations, promotion cursor.
--
-- This is the constrained side of the split described in docs/technical/ERD.md section 1.1. The
-- built-in PostgreSQL Database Changes sink owns the `raw_erc4626_*` staging tables and rewrites
-- them while undoing pre-confirmation reorgs; nothing here is ever written by the sink. The
-- promotion worker copies rows at or below the confirmed head into these tables, which is where
-- foreign keys, CHECK constraints, and report references belong. That separation is the reason a
-- sink undo never has to fight a report's foreign key.
--
-- Hand-written rather than generated: the composite foreign keys, the partial unique index, and
-- the canonicality trigger below encode integrity rules that a schema differ has no way to infer.
--
-- Every enum-like CHECK list is generated from the zod `.options` in @tr4ce/domain. A unit test in
-- packages/db/src/migration.test.ts asserts the two still agree, so widening an enum without
-- widening the constraint fails the build rather than an insert months later.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Registry (ERD section 3)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS network (
    chain_id           BIGINT      PRIMARY KEY,
    slug               TEXT        NOT NULL UNIQUE,
    name               TEXT        NOT NULL,
    native_symbol      TEXT        NOT NULL,
    -- Operational finality setting, read by the promotion worker. Not a constant in code: a chain
    -- with a different reorg profile is a row change, not a deploy.
    confirmation_depth INTEGER     NOT NULL,
    enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT network_confirmation_depth_check CHECK (confirmation_depth >= 0)
);

CREATE TABLE IF NOT EXISTS protocol (
    id                UUID PRIMARY KEY,
    slug              TEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    adapter_key       TEXT NOT NULL,
    documentation_url TEXT
);

CREATE TABLE IF NOT EXISTS asset (
    id                UUID          PRIMARY KEY,
    chain_id          BIGINT        NOT NULL REFERENCES network (chain_id),
    address           BYTEA         NOT NULL,
    -- Untrusted display metadata. Identity rests on canonical_key plus the curated address; a
    -- ticker string never decides what a token is.
    symbol            TEXT,
    name              TEXT,
    decimals          SMALLINT      NOT NULL,
    canonical_key     TEXT          NOT NULL,
    verified_at_block NUMERIC(78,0),
    code_hash         BYTEA,
    CONSTRAINT asset_address_length_check CHECK (octet_length(address) = 20),
    CONSTRAINT asset_decimals_check CHECK (decimals BETWEEN 0 AND 255)
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_chain_address_key ON asset (chain_id, address);

CREATE TABLE IF NOT EXISTS vault (
    id               UUID          PRIMARY KEY,
    chain_id         BIGINT        NOT NULL REFERENCES network (chain_id),
    address          BYTEA         NOT NULL,
    protocol_id      UUID          NOT NULL REFERENCES protocol (id),
    asset_id         UUID          NOT NULL REFERENCES asset (id),
    share_decimals   SMALLINT      NOT NULL,
    name             TEXT,
    symbol           TEXT,
    -- Provenance only. The Substreams initialBlock follows the manifest observation window;
    -- pinning it here would force a months-long replay on every cold start.
    deployment_block NUMERIC(78,0),
    code_hash        BYTEA         NOT NULL,
    status           TEXT          NOT NULL,
    status_reason    TEXT,
    verified_at      TIMESTAMPTZ   NOT NULL,
    CONSTRAINT vault_address_length_check CHECK (octet_length(address) = 20),
    CONSTRAINT vault_share_decimals_check CHECK (share_decimals BETWEEN 0 AND 255),
    CONSTRAINT vault_status_check CHECK (status IN ('candidate', 'listed', 'degraded', 'unsupported'))
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_chain_address_key ON vault (chain_id, address);
-- Referenced by the composite foreign keys below, which keep an observation and any report citing
-- it on the same chain as the vault they claim to describe.
CREATE UNIQUE INDEX IF NOT EXISTS vault_id_chain_key ON vault (id, chain_id);
CREATE INDEX IF NOT EXISTS vault_asset_idx ON vault (asset_id);

CREATE TABLE IF NOT EXISTS vault_capability (
    id                        UUID          PRIMARY KEY,
    vault_id                  UUID          NOT NULL REFERENCES vault (id),
    adapter_key               TEXT          NOT NULL,
    adapter_version           TEXT          NOT NULL,
    implementation_address    BYTEA,
    implementation_code_hash  BYTEA,
    capabilities              JSONB         NOT NULL,
    effective_from_block      NUMERIC(78,0) NOT NULL,
    effective_to_block        NUMERIC(78,0),
    verified_at               TIMESTAMPTZ   NOT NULL,
    CONSTRAINT vault_capability_range_check
        CHECK (effective_to_block IS NULL OR effective_to_block > effective_from_block)
);

CREATE INDEX IF NOT EXISTS vault_capability_vault_from_idx
    ON vault_capability (vault_id, effective_from_block);
CREATE UNIQUE INDEX IF NOT EXISTS vault_capability_id_vault_key ON vault_capability (id, vault_id);
-- At most one open profile per vault. A changed implementation closes the open row by setting
-- effective_to_block and inserts a new one; profiles are never mutated, because an old report has
-- to keep resolving to the interpretation that was in force when it was written.
CREATE UNIQUE INDEX IF NOT EXISTS vault_capability_open_key
    ON vault_capability (vault_id) WHERE effective_to_block IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Confirmed observations (ERD section 4)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vault_flow (
    id               UUID          PRIMARY KEY,
    vault_id         UUID          NOT NULL REFERENCES vault (id),
    chain_id         BIGINT        NOT NULL,
    block_number     NUMERIC(78,0) NOT NULL,
    block_hash       BYTEA         NOT NULL,
    block_time       TIMESTAMPTZ   NOT NULL,
    transaction_hash BYTEA         NOT NULL,
    log_index        INTEGER       NOT NULL,
    kind             TEXT          NOT NULL,
    -- Only meaningful for share_transfer; NULL for deposits and withdrawals.
    transfer_kind    TEXT,
    sender           BYTEA,
    owner            BYTEA,
    receiver         BYTEA,
    -- NULL by event kind: a share transfer moves no assets. NULL is never rewritten to zero.
    assets           NUMERIC(78,0),
    shares           NUMERIC(78,0) NOT NULL,
    -- Reorg state. A detected deep reorg flips this to FALSE; rows are never deleted, because the
    -- record of what was believed is itself the audit artifact (ERD section 11).
    canonical        BOOLEAN       NOT NULL DEFAULT TRUE,
    schema_version   TEXT          NOT NULL,
    promoted_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT vault_flow_kind_check CHECK (kind IN ('deposit', 'withdraw', 'share_transfer')),
    CONSTRAINT vault_flow_transfer_kind_check
        CHECK (transfer_kind IS NULL OR transfer_kind IN ('transfer', 'mint', 'burn', 'unspecified')),
    -- A share_transfer without a classification would silently become an unclassified economic
    -- movement, which is the one thing the transfer table exists to prevent.
    CONSTRAINT vault_flow_transfer_kind_presence_check
        CHECK ((kind = 'share_transfer') = (transfer_kind IS NOT NULL)),
    CONSTRAINT vault_flow_block_hash_length_check CHECK (octet_length(block_hash) = 32),
    CONSTRAINT vault_flow_transaction_hash_length_check CHECK (octet_length(transaction_hash) = 32),
    CONSTRAINT vault_flow_log_index_check CHECK (log_index >= 0),
    CONSTRAINT vault_flow_assets_check CHECK (assets IS NULL OR assets >= 0),
    CONSTRAINT vault_flow_shares_check CHECK (shares >= 0),
    -- Keeps a flow on the same chain as the vault it is attributed to.
    CONSTRAINT vault_flow_vault_chain_fk
        FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id)
);

-- Canonical event identity (ARCHITECTURE.md section 4.1). `kind` is part of the key so one log
-- position cannot be claimed by two kinds; never deduplicate on transaction hash alone, since a
-- single transaction emits several vault events.
CREATE UNIQUE INDEX IF NOT EXISTS vault_flow_event_key
    ON vault_flow (chain_id, block_hash, transaction_hash, log_index, kind);
CREATE INDEX IF NOT EXISTS vault_flow_vault_block_idx ON vault_flow (vault_id, block_number);
CREATE INDEX IF NOT EXISTS vault_flow_reorg_idx ON vault_flow (chain_id, block_number, canonical);
CREATE UNIQUE INDEX IF NOT EXISTS vault_flow_id_vault_key ON vault_flow (id, vault_id);

CREATE TABLE IF NOT EXISTS vault_snapshot (
    id                 UUID          PRIMARY KEY,
    vault_id           UUID          NOT NULL REFERENCES vault (id),
    -- The capability profile in force at this block, resolved during promotion against the
    -- profile's [effective_from_block, effective_to_block) range. A snapshot with no covering
    -- profile aborts the batch; it is never stored with a null interpretation.
    capability_id      UUID          NOT NULL REFERENCES vault_capability (id),
    chain_id           BIGINT        NOT NULL,
    block_number       NUMERIC(78,0) NOT NULL,
    block_hash         BYTEA         NOT NULL,
    block_time         TIMESTAMPTZ   NOT NULL,
    -- Every read result is nullable because a failed call has no value. NULL means the call
    -- produced nothing usable. It never means zero.
    total_assets       NUMERIC(78,0),
    total_supply       NUMERIC(78,0),
    one_share_units    NUMERIC(78,0) NOT NULL,
    one_share_assets   NUMERIC(78,0),
    call_status        TEXT          NOT NULL,
    call_errors        JSONB         NOT NULL DEFAULT '[]'::jsonb,
    trigger_activity   BOOLEAN       NOT NULL,
    trigger_checkpoint BOOLEAN       NOT NULL,
    trigger_anchor     BOOLEAN       NOT NULL,
    canonical          BOOLEAN       NOT NULL DEFAULT TRUE,
    schema_version     TEXT          NOT NULL,
    observed_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT vault_snapshot_call_status_check
        CHECK (call_status IN ('ok', 'partial', 'reverted', 'unspecified')),
    CONSTRAINT vault_snapshot_call_errors_check CHECK (jsonb_typeof(call_errors) = 'array'),
    -- A non-ok status must carry its per-method failures, and an ok one must not invent any: this
    -- is what keeps "missing evidence" explicit rather than silently absent.
    CONSTRAINT vault_snapshot_call_errors_presence_check
        CHECK ((call_status = 'ok') = (jsonb_array_length(call_errors) = 0)),
    CONSTRAINT vault_snapshot_block_hash_length_check CHECK (octet_length(block_hash) = 32),
    CONSTRAINT vault_snapshot_total_assets_check CHECK (total_assets IS NULL OR total_assets >= 0),
    CONSTRAINT vault_snapshot_total_supply_check CHECK (total_supply IS NULL OR total_supply >= 0),
    CONSTRAINT vault_snapshot_one_share_units_check CHECK (one_share_units > 0),
    CONSTRAINT vault_snapshot_one_share_assets_check
        CHECK (one_share_assets IS NULL OR one_share_assets >= 0),
    -- No snapshot may be triggered by nothing; the trigger flags are the audit trail for why an
    -- observation exists at this block at all.
    CONSTRAINT vault_snapshot_trigger_check
        CHECK (trigger_activity OR trigger_checkpoint OR trigger_anchor),
    CONSTRAINT vault_snapshot_vault_chain_fk
        FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id),
    -- Pins the capability profile to this snapshot's own vault.
    CONSTRAINT vault_snapshot_capability_vault_fk
        FOREIGN KEY (capability_id, vault_id) REFERENCES vault_capability (id, vault_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_snapshot_identity_key
    ON vault_snapshot (vault_id, block_hash, schema_version);
CREATE INDEX IF NOT EXISTS vault_snapshot_vault_block_idx ON vault_snapshot (vault_id, block_number);
CREATE INDEX IF NOT EXISTS vault_snapshot_reorg_idx
    ON vault_snapshot (chain_id, block_number, canonical);
CREATE UNIQUE INDEX IF NOT EXISTS vault_snapshot_id_vault_key ON vault_snapshot (id, vault_id);

-- ---------------------------------------------------------------------------------------------
-- Promotion cursor (ERD section 4, `indexer_cursor`)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS indexer_cursor (
    chain_id       BIGINT        NOT NULL,
    stream_key     TEXT          NOT NULL,
    block_number   NUMERIC(78,0) NOT NULL,
    -- The exact hash promoted at block_number. A mismatch against the chain is how a deep reorg
    -- is detected after the fact.
    block_hash     BYTEA         NOT NULL,
    schema_version TEXT          NOT NULL,
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, stream_key),
    CONSTRAINT indexer_cursor_block_hash_length_check CHECK (octet_length(block_hash) = 32)
);

-- ---------------------------------------------------------------------------------------------
-- Minimal report identity (ERD section 6)
--
-- Task 6 owns the full evidence report schema: rule results, rpc observations, policy version
-- links, immutable payloads. Defined here is only what a deep reorg has to be able to reach,
-- because "a detected deep reorg invalidates every promoted dependent" is a Task 3 acceptance
-- clause and cannot be proven against tables that do not exist. Task 6 extends these; it does not
-- replace them.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_report (
    id                  UUID          PRIMARY KEY,
    vault_id            UUID          NOT NULL REFERENCES vault (id),
    chain_id            BIGINT        NOT NULL,
    as_of_block_number  NUMERIC(78,0) NOT NULL,
    as_of_block_hash    BYTEA         NOT NULL,
    schema_version      TEXT          NOT NULL,
    calculation_version TEXT          NOT NULL,
    -- Invalidation is state, not deletion. An invalidated report stays readable and stays cited;
    -- it simply stops being canonical.
    canonical           BOOLEAN       NOT NULL DEFAULT TRUE,
    invalidated_at      TIMESTAMPTZ,
    invalidation_reason TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT evidence_report_block_hash_length_check CHECK (octet_length(as_of_block_hash) = 32),
    CONSTRAINT evidence_report_invalidation_check
        CHECK (canonical = (invalidated_at IS NULL) AND canonical = (invalidation_reason IS NULL)),
    CONSTRAINT evidence_report_vault_chain_fk
        FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id)
);

CREATE INDEX IF NOT EXISTS evidence_report_vault_idx ON evidence_report (vault_id, as_of_block_number);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_report_id_vault_key ON evidence_report (id, vault_id);

CREATE TABLE IF NOT EXISTS report_observation (
    id                UUID PRIMARY KEY,
    report_id         UUID NOT NULL REFERENCES evidence_report (id),
    vault_id          UUID NOT NULL REFERENCES vault (id),
    vault_flow_id     UUID REFERENCES vault_flow (id),
    vault_snapshot_id UUID REFERENCES vault_snapshot (id),
    role              TEXT NOT NULL,
    CONSTRAINT report_observation_exactly_one_check
        CHECK (num_nonnulls(vault_flow_id, vault_snapshot_id) = 1),
    -- The three composite keys are the point of this table: they make it structurally impossible
    -- for a report on one vault to cite another vault's observation through an application bug
    -- (ERD section 11). MATCH SIMPLE leaves a row with a NULL observation column unchecked, which
    -- is exactly the intent — only the column that is set is verified.
    CONSTRAINT report_observation_report_vault_fk
        FOREIGN KEY (report_id, vault_id) REFERENCES evidence_report (id, vault_id),
    CONSTRAINT report_observation_flow_vault_fk
        FOREIGN KEY (vault_flow_id, vault_id) REFERENCES vault_flow (id, vault_id),
    CONSTRAINT report_observation_snapshot_vault_fk
        FOREIGN KEY (vault_snapshot_id, vault_id) REFERENCES vault_snapshot (id, vault_id)
);

-- NULLS NOT DISTINCT so a repeated citation is actually rejected; under the default, every row
-- with a NULL observation column would be treated as unique and duplicates would slip through.
CREATE UNIQUE INDEX IF NOT EXISTS report_observation_unique
    ON report_observation (report_id, vault_flow_id, vault_snapshot_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS report_observation_flow_idx ON report_observation (vault_flow_id);
CREATE INDEX IF NOT EXISTS report_observation_snapshot_idx ON report_observation (vault_snapshot_id);

-- ---------------------------------------------------------------------------------------------
-- Reorg audit trail
--
-- Append-only: one row per subject invalidated by one detected deep reorg. Nothing here is ever
-- updated or deleted. The record of what was believed, and when it stopped being true, is the
-- artifact (ERD section 11).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reorg_invalidation (
    id                   UUID          PRIMARY KEY,
    chain_id             BIGINT        NOT NULL REFERENCES network (chain_id),
    block_number         NUMERIC(78,0) NOT NULL,
    orphaned_block_hash  BYTEA         NOT NULL,
    canonical_block_hash BYTEA         NOT NULL,
    subject_kind         TEXT          NOT NULL,
    subject_id           UUID          NOT NULL,
    reason_code          TEXT          NOT NULL,
    detected_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT reorg_invalidation_subject_kind_check
        CHECK (subject_kind IN ('vault_flow', 'vault_snapshot', 'evidence_report')),
    CONSTRAINT reorg_invalidation_reason_code_check
        CHECK (reason_code IN (
            'MISSING_OBSERVATION', 'STALE_EVIDENCE', 'INCOMPATIBLE_ASSET',
            'INCOMPATIBLE_IMPLEMENTATION', 'CALL_REVERTED', 'UNSUPPORTED_CAPABILITY',
            'AMBIGUOUS_CAPABILITY', 'UNSUPPORTED_VAULT', 'PROVIDER_UNAVAILABLE',
            'REORG_INVALIDATED', 'INVALID_POLICY', 'SIMULATION_REVERTED',
            'SIMULATION_STALE', 'WALLET_CONTEXT_CHANGED'
        )),
    CONSTRAINT reorg_invalidation_hash_differs_check
        CHECK (orphaned_block_hash <> canonical_block_hash)
);

CREATE INDEX IF NOT EXISTS reorg_invalidation_subject_idx
    ON reorg_invalidation (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS reorg_invalidation_block_idx
    ON reorg_invalidation (chain_id, block_number);

-- ---------------------------------------------------------------------------------------------
-- "A report cannot reference non-canonical observations at creation time" (ERD section 11)
--
-- Enforced in the database rather than in application code because the rule protects against
-- application bugs, and a rule enforced only by the code it guards is not enforced. Deliberately
-- a creation-time check: a later reorg legitimately turns a cited observation non-canonical, and
-- that path invalidates the report instead of rejecting the row.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION report_observation_requires_canonical() RETURNS TRIGGER AS $$
DECLARE
    is_canonical BOOLEAN;
BEGIN
    IF NEW.vault_flow_id IS NOT NULL THEN
        SELECT canonical INTO is_canonical FROM vault_flow WHERE id = NEW.vault_flow_id;
        IF NOT is_canonical THEN
            RAISE EXCEPTION 'report % cites non-canonical vault_flow %', NEW.report_id, NEW.vault_flow_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    IF NEW.vault_snapshot_id IS NOT NULL THEN
        SELECT canonical INTO is_canonical FROM vault_snapshot WHERE id = NEW.vault_snapshot_id;
        IF NOT is_canonical THEN
            RAISE EXCEPTION 'report % cites non-canonical vault_snapshot %', NEW.report_id, NEW.vault_snapshot_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_observation_canonical_trigger ON report_observation;
CREATE TRIGGER report_observation_canonical_trigger
    BEFORE INSERT ON report_observation
    FOR EACH ROW EXECUTE FUNCTION report_observation_requires_canonical();

COMMIT;
