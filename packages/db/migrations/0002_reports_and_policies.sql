-- TR4CE application schema: user policy and derived evidence.
--
-- Completes the ERD sections 5 and 6 tables that Task 3 could only stub. Same rules as 0001: the
-- SQL is hand-written because the composite foreign keys and the exactly-one-citation CHECK encode
-- integrity rules a schema differ cannot infer, and every enum-like CHECK list is generated from
-- the zod `.options` in @tr4ce/domain with a test in packages/db/src/migration.test.ts holding the
-- two together.
--
-- `evidence_report` and `report_observation` are dropped and recreated rather than altered.
-- Task 3 shipped minimal versions of both so that "invalidates every promoted dependent" could be
-- demonstrated against tables that existed, and predicted here that Task 6 would extend them. That
-- prediction was wrong: the ERD gives `evidence_report.id` type `text` (our ids are `trc_<hex>`),
-- so the primary key changes type and half the columns are new. Rewriting reads far more clearly
-- than a column-by-column ALTER.
--
-- The rewrite is safe because both tables have only ever been empty — no code outside the test
-- suite has written to either — and the guard below refuses to run if that stops being true. A
-- migration that silently destroys evidence would contradict the entire product, so it fails loudly
-- instead. That guard also preserves the replay-safety property migrate.ts relies on: if the
-- process dies between applying this file and recording it, the tables it re-creates are empty and
-- the replay is a no-op.

BEGIN;

DO $$
BEGIN
    -- Nested rather than `IS NOT NULL AND EXISTS (…)`: plpgsql plans a statement when it is first
    -- reached, and the flat form puts both operands in one expression, so it plans the SELECT even
    -- when to_regclass says the table is absent and fails with "relation does not exist". The
    -- inner IF is only reached, and therefore only planned, once the table is known to be there.
    IF to_regclass('evidence_report') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM evidence_report) THEN
            RAISE EXCEPTION 'evidence_report holds rows; 0002 will not drop it. Migrate the rows first.'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
END
$$;

-- Dependents first, and `rule_result` is among them even though this file creates it: migrate.ts
-- replays a file that was applied but not recorded, and without this line that replay fails on
-- "cannot drop table evidence_report because other objects depend on it". CASCADE would do it in
-- one line and would also silently drop anything added later, which is the opposite of what a
-- migration should do.
DROP TRIGGER IF EXISTS report_observation_canonical_trigger ON report_observation;
DROP TABLE IF EXISTS rule_result;
DROP TABLE IF EXISTS report_observation;
DROP TABLE IF EXISTS evidence_report;

-- `reorg_invalidation` names its subject by id across three tables, and one of them just stopped
-- being a UUID. Widening to TEXT keeps `evidence_report` recordable in the audit trail, which
-- ERD section 11 requires and the subject_kind CHECK in 0001 already lists. The alternative — a
-- second nullable id column — would let a row name no subject at all.
--
-- Lossless: every existing value is a UUID, and a UUID is a valid TEXT.
ALTER TABLE reorg_invalidation ALTER COLUMN subject_id TYPE TEXT;

-- ---------------------------------------------------------------------------------------------
-- User policy (ERD section 5)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wallet (
    id          UUID        PRIMARY KEY,
    -- A UI preference, explicitly not part of identity: the same address is the same wallet
    -- whichever chain it was last seen on.
    chain_scope TEXT,
    address     BYTEA       NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT wallet_address_length_check CHECK (octet_length(address) = 20)
);

CREATE TABLE IF NOT EXISTS policy (
    id          UUID        PRIMARY KEY,
    wallet_id   UUID        NOT NULL REFERENCES wallet (id),
    name        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Archiving is a state change, not a delete: a report cites the policy version it was judged
    -- against, and that citation has to keep resolving forever.
    archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS policy_wallet_idx ON policy (wallet_id);

CREATE TABLE IF NOT EXISTS policy_version (
    id             UUID        PRIMARY KEY,
    policy_id      UUID        NOT NULL REFERENCES policy (id),
    version_number INTEGER     NOT NULL,
    schema_version TEXT        NOT NULL,
    -- The canonical artifact. `policy_rule` below is a queryable projection of this, never the
    -- other way round.
    canonical_json JSONB       NOT NULL,
    content_hash   BYTEA       NOT NULL,
    source         TEXT        NOT NULL,
    -- A drafted policy is not a confirmed one. NULL means a person has not yet accepted it, and
    -- nothing may evaluate against an unconfirmed version (PRD TR-F-024).
    confirmed_at   TIMESTAMPTZ,
    CONSTRAINT policy_version_number_check CHECK (version_number > 0),
    CONSTRAINT policy_version_content_hash_length_check CHECK (octet_length(content_hash) = 32),
    CONSTRAINT policy_version_source_check CHECK (source IN ('manual', 'llm_import'))
);

CREATE UNIQUE INDEX IF NOT EXISTS policy_version_number_key
    ON policy_version (policy_id, version_number);
-- Re-saving an unchanged policy must not mint a new version, or the version history stops meaning
-- "the policy changed here".
CREATE UNIQUE INDEX IF NOT EXISTS policy_version_content_key
    ON policy_version (policy_id, content_hash);

CREATE TABLE IF NOT EXISTS policy_rule (
    id                UUID    PRIMARY KEY,
    policy_version_id UUID    NOT NULL REFERENCES policy_version (id),
    rule_key          TEXT    NOT NULL,
    operator          TEXT    NOT NULL,
    value_json        JSONB   NOT NULL,
    ordinal           INTEGER NOT NULL,
    CONSTRAINT policy_rule_key_check
        CHECK (rule_key IN (
            'underlyingAsset', 'minimumHistory', 'minimumTvl',
            'minimumObservedReturn', 'minimumWithdrawableAssets'
        )),
    CONSTRAINT policy_rule_operator_check
        CHECK (operator IN ('in', 'gte')),
    CONSTRAINT policy_rule_ordinal_check CHECK (ordinal >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS policy_rule_key_unique
    ON policy_rule (policy_version_id, rule_key);
-- Referenced by rule_result's composite foreign key, which keeps a result on a rule that belongs
-- to the version the report was actually judged against.
CREATE UNIQUE INDEX IF NOT EXISTS policy_rule_id_version_key
    ON policy_rule (id, policy_version_id);

-- ---------------------------------------------------------------------------------------------
-- Derived evidence (ERD section 6)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_report (
    -- `trc_` plus the first 32 hex of canonical_input_hash. ERD section 6 calls for a sortable
    -- generated id; a content-derived one is used instead so that "the same observations name the
    -- same report" holds by construction rather than by a lookup before every insert. Ordering is
    -- served by created_at and as_of_block_number, both indexed below.
    id                      TEXT          PRIMARY KEY,
    vault_id                UUID          NOT NULL REFERENCES vault (id),
    chain_id                BIGINT        NOT NULL,
    -- NULL for an evidence-only report. Evidence stands on its own; a policy is a question asked
    -- of it, not a precondition for producing it.
    policy_version_id       UUID          REFERENCES policy_version (id),
    as_of_block_number      NUMERIC(78,0) NOT NULL,
    as_of_block_hash        BYTEA         NOT NULL,
    as_of_time              TIMESTAMPTZ   NOT NULL,
    -- The window asked for, and the spacing actually observed. Kept apart because the nearest
    -- available snapshot is rarely exactly N days back, and a return quoted over an assumed period
    -- is a different number from the one that was measured (ARCHITECTURE.md section 4.2).
    window_seconds          BIGINT        NOT NULL,
    actual_elapsed_seconds  BIGINT,
    calculation_version     TEXT          NOT NULL,
    schema_version          TEXT          NOT NULL,
    status                  TEXT          NOT NULL,
    -- The exact validated response that was served. Immutable: a report is re-read, never
    -- recomputed, so a later change to the engine cannot rewrite what a user was shown.
    result_json             JSONB         NOT NULL,
    canonical_input_hash    BYTEA         NOT NULL,
    -- Invalidation is state, not deletion. An invalidated report stays readable and stays cited;
    -- it simply stops being canonical.
    canonical               BOOLEAN       NOT NULL DEFAULT TRUE,
    invalidated_at          TIMESTAMPTZ,
    invalidation_reason     TEXT,
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT evidence_report_id_format_check CHECK (id ~ '^trc_[0-9a-f]{32}$'),
    CONSTRAINT evidence_report_block_hash_length_check CHECK (octet_length(as_of_block_hash) = 32),
    CONSTRAINT evidence_report_input_hash_length_check
        CHECK (octet_length(canonical_input_hash) = 32),
    CONSTRAINT evidence_report_window_seconds_check CHECK (window_seconds > 0),
    CONSTRAINT evidence_report_elapsed_seconds_check
        CHECK (actual_elapsed_seconds IS NULL OR actual_elapsed_seconds >= 0),
    CONSTRAINT evidence_report_status_check
        CHECK (status IN ('pass', 'fail', 'unknown', 'not_evaluated')),
    -- A report with no policy attached cannot have reached a verdict, and one that was evaluated
    -- must have. Without this the two states are only a convention.
    CONSTRAINT evidence_report_policy_status_check
        CHECK ((policy_version_id IS NULL) = (status = 'not_evaluated')),
    CONSTRAINT evidence_report_invalidation_check
        CHECK (canonical = (invalidated_at IS NULL) AND canonical = (invalidation_reason IS NULL)),
    CONSTRAINT evidence_report_vault_chain_fk
        FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id)
);

CREATE INDEX IF NOT EXISTS evidence_report_vault_idx ON evidence_report (vault_id, as_of_block_number);
CREATE INDEX IF NOT EXISTS evidence_report_created_idx ON evidence_report (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_report_id_vault_key ON evidence_report (id, vault_id);
-- ERD section 6: prevents duplicate equivalent reports. The id is derived from the same hash, so
-- this is belt and braces on purpose — it is the constraint that states the intent, and it also
-- catches a report whose schema_version moved while its inputs did not.
--
-- Note the asymmetry: calculation_version is inside the hash, schema_version is not. At schema v1
-- that cannot bite, because the version is a literal. When a v2 arrives, two reports over the same
-- observations would share one id while this index treats them as distinct, and the second insert
-- would fail as a primary key violation dressed up as a dedup hit. Widening the hashed surface to
-- include schema_version is the fix at that point.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_report_input_key
    ON evidence_report (canonical_input_hash, calculation_version, schema_version);

-- ---------------------------------------------------------------------------------------------
-- Current and account-scoped call evidence (ERD section 6, `rpc_observation`)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rpc_observation (
    id               UUID          PRIMARY KEY,
    chain_id         BIGINT        NOT NULL REFERENCES network (chain_id),
    contract_address BYTEA         NOT NULL,
    method_selector  BYTEA         NOT NULL,
    args_hash        BYTEA         NOT NULL,
    block_number     NUMERIC(78,0) NOT NULL,
    block_hash       BYTEA         NOT NULL,
    -- The chain's answer, byte for byte, kept beside the interpretation of it rather than replaced
    -- by it. NULL when the call produced nothing; never a substituted zero.
    raw_result       BYTEA,
    revert_data      BYTEA,
    call_status      TEXT          NOT NULL,
    decoded_json     JSONB,
    -- A key naming the provider, never a credential (ERD section 6 states this outright).
    provider_key     TEXT          NOT NULL,
    observed_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT rpc_observation_address_length_check CHECK (octet_length(contract_address) = 20),
    CONSTRAINT rpc_observation_selector_length_check CHECK (octet_length(method_selector) = 4),
    CONSTRAINT rpc_observation_args_hash_length_check CHECK (octet_length(args_hash) = 32),
    CONSTRAINT rpc_observation_block_hash_length_check CHECK (octet_length(block_hash) = 32),
    CONSTRAINT rpc_observation_call_status_check
        CHECK (call_status IN ('ok', 'partial', 'reverted', 'unspecified')),
    -- An ok call has a return and no revert; a reverted one is the other way round. This is the
    -- same "missing evidence stays explicit" rule vault_snapshot.call_errors enforces.
    CONSTRAINT rpc_observation_result_presence_check
        CHECK ((call_status = 'ok') = (raw_result IS NOT NULL AND revert_data IS NULL))
);

CREATE INDEX IF NOT EXISTS rpc_observation_contract_idx
    ON rpc_observation (chain_id, contract_address, block_number);

-- ---------------------------------------------------------------------------------------------
-- Report citations (ERD section 6, `report_observation`)
--
-- The link from a claim to the exact rows that support it. This table is the reason a TR4CE report
-- can be checked rather than believed.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS report_observation (
    id                  UUID    PRIMARY KEY,
    report_id           TEXT    NOT NULL REFERENCES evidence_report (id),
    vault_id            UUID    NOT NULL REFERENCES vault (id),
    observation_type    TEXT    NOT NULL,
    vault_flow_id       UUID    REFERENCES vault_flow (id),
    vault_snapshot_id   UUID    REFERENCES vault_snapshot (id),
    rpc_observation_id  UUID    REFERENCES rpc_observation (id),
    purpose             TEXT    NOT NULL,
    ordinal             INTEGER NOT NULL,
    CONSTRAINT report_observation_type_check
        CHECK (observation_type IN ('snapshot', 'flow', 'rpc_call')),
    CONSTRAINT report_observation_purpose_check
        CHECK (purpose IN ('start', 'end', 'net_flow', 'account_limit', 'simulation_input')),
    CONSTRAINT report_observation_ordinal_check CHECK (ordinal >= 0),
    CONSTRAINT report_observation_exactly_one_check
        CHECK (num_nonnulls(vault_flow_id, vault_snapshot_id, rpc_observation_id) = 1),
    -- observation_type is not free to disagree with which column is populated. Storing both and
    -- letting them diverge would mean a reader could not trust either.
    CONSTRAINT report_observation_type_matches_check
        CHECK (
            (observation_type = 'flow'     AND vault_flow_id IS NOT NULL) OR
            (observation_type = 'snapshot' AND vault_snapshot_id IS NOT NULL) OR
            (observation_type = 'rpc_call' AND rpc_observation_id IS NOT NULL)
        ),
    -- The three composite keys are the point of this table: they make it structurally impossible
    -- for a report on one vault to cite another vault's observation through an application bug
    -- (ERD section 11). MATCH SIMPLE leaves a row with a NULL observation column unchecked, which
    -- is exactly the intent — only the column that is set is verified.
    --
    -- rpc_observation is not among them: it records a call to an arbitrary contract and carries no
    -- vault_id to match against. The vault_id column here still ties the citation to the report's
    -- own vault through the composite key on report_id.
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
    ON report_observation (report_id, vault_flow_id, vault_snapshot_id, rpc_observation_id)
    NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS report_observation_report_idx ON report_observation (report_id, ordinal);
CREATE INDEX IF NOT EXISTS report_observation_flow_idx ON report_observation (vault_flow_id);
CREATE INDEX IF NOT EXISTS report_observation_snapshot_idx ON report_observation (vault_snapshot_id);
CREATE INDEX IF NOT EXISTS report_observation_rpc_idx ON report_observation (rpc_observation_id);

-- ---------------------------------------------------------------------------------------------
-- Per-rule verdicts (ERD section 6, `rule_result`)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rule_result (
    id                UUID    PRIMARY KEY,
    report_id         TEXT    NOT NULL REFERENCES evidence_report (id),
    policy_rule_id    UUID    NOT NULL REFERENCES policy_rule (id),
    policy_version_id UUID    NOT NULL REFERENCES policy_version (id),
    status            TEXT    NOT NULL,
    -- Typed observed value and threshold, stored side by side so the verdict can be re-derived
    -- from the row without re-reading the chain.
    observed_json     JSONB,
    threshold_json    JSONB   NOT NULL,
    reason_codes      TEXT[]  NOT NULL DEFAULT '{}',
    evidence_refs     UUID[]  NOT NULL DEFAULT '{}',
    CONSTRAINT rule_result_status_check CHECK (status IN ('pass', 'fail', 'unknown')),
    -- A PASS with nothing observed would be a verdict with no basis.
    CONSTRAINT rule_result_observed_presence_check
        CHECK (status <> 'pass' OR observed_json IS NOT NULL),
    -- Keeps a result on a rule that belongs to the version the report was judged against.
    CONSTRAINT rule_result_rule_version_fk
        FOREIGN KEY (policy_rule_id, policy_version_id)
        REFERENCES policy_rule (id, policy_version_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS rule_result_report_rule_key
    ON rule_result (report_id, policy_rule_id);
CREATE INDEX IF NOT EXISTS rule_result_report_idx ON rule_result (report_id);

-- ---------------------------------------------------------------------------------------------
-- "A report cannot reference non-canonical observations at creation time" (ERD section 11)
--
-- Recreated because report_observation was dropped above; the trigger function itself is unchanged
-- apart from the rpc_observation arm, which has no canonicality of its own — an RPC call is a
-- point-in-time reading, not a chain-state row that a reorg can orphan.
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
