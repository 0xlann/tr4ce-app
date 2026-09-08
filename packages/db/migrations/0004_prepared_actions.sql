-- Prepared actions, their simulations, and the receipts that came back (ERD.md section 7).
--
-- The load-bearing sentence in that section is four words long: "No signature is stored." Nothing
-- here has a column for one, and nothing upstream produces one — @tr4ce/chain carries no signer and
-- a test there fails if any file so much as names viem's wallet half. TR4CE learns a transaction
-- hash only because the caller hands one back after their wallet submitted it (PRD TR-F-043).
--
-- Same rules as the earlier migrations: hand-written because the composite foreign keys and the
-- status/receipt CHECKs encode integrity a schema differ cannot infer, and every enum-like CHECK
-- list is generated from the zod `.options` in @tr4ce/domain.

BEGIN;

CREATE TABLE IF NOT EXISTS prepared_action (
    -- `act_` plus 32 hex, generated rather than derived from the action's content.
    --
    -- Unlike evidence_report.id, deliberately. A report is a pure function of its observations, so
    -- naming it after them makes "same input, same report" true by construction. An action is an
    -- intent to spend, and repeating one is legitimate: the exact approval this migration's
    -- callers write leaves the allowance back at zero, so a second identical deposit is a second
    -- real action and must be able to exist. Idempotency lives instead on the partial unique index
    -- over calldata_hash below, which covers only actions still awaiting signature.
    id                  TEXT          PRIMARY KEY,
    wallet_id           UUID          NOT NULL REFERENCES wallet (id),
    vault_id            UUID          NOT NULL REFERENCES vault (id),
    -- Nullable motivation. An action can be prepared without a report having asked for it, and a
    -- report is evidence rather than a precondition.
    report_id           TEXT,
    kind                TEXT          NOT NULL,
    chain_id            BIGINT        NOT NULL,
    account             BYTEA         NOT NULL,
    -- The action digest: chain, account, every call in signing order, capability version.
    -- ERD section 7 calls it "immutable action identity" — a column, not the primary key.
    --
    -- The block is deliberately absent. It belongs to a *simulation*, which is pinned to one block
    -- and expires with it, and it lives on that table. Folding it in here would change an action's
    -- identity every two seconds on Base, so an approval and the deposit that follows it could
    -- never belong to the same action.
    calldata_hash       BYTEA         NOT NULL,
    -- Which interpretation of this vault's reads was in force: the seventh bound field in
    -- SMART-CONTRACT.md section 6. Stored because a binding whose fields were not kept cannot be
    -- re-checked, and every later simulation of this action has to be bound to the same one.
    capability_version  TEXT          NOT NULL,
    -- Every unsigned call, in signing order. A deposit is two when the allowance falls short and
    -- one when it does not, so the count is an observation rather than a constant.
    transactions_json   JSONB         NOT NULL,
    -- How many of those calls the caller has reported a hash for. A two-call deposit sits at 1
    -- between the approval and the deposit, which is the state the whole flow turns on.
    sent_count          INTEGER       NOT NULL DEFAULT 0,
    -- What the vault previewed for this amount: shares for a deposit, assets for a redemption
    -- (PRD TR-F-030, TR-F-031). Kept so the actual figure the receipt reports can be shown beside
    -- it — SMART-CONTRACT.md sections 4 and 5 require the actual to come from execution evidence
    -- and to be "not replaced by preview".
    previewed_amount    NUMERIC(78,0) NOT NULL,
    status              TEXT          NOT NULL,
    expires_at          TIMESTAMPTZ   NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    invalidated_reason  TEXT,
    CONSTRAINT prepared_action_id_format_check CHECK (id ~ '^act_[0-9a-f]{32}$'),
    CONSTRAINT prepared_action_kind_check CHECK (kind IN ('deposit', 'redeem')),
    CONSTRAINT prepared_action_status_check
        CHECK (status IN ('prepared', 'simulated', 'submitted', 'confirmed', 'reverted', 'expired', 'invalidated')),
    CONSTRAINT prepared_action_account_length_check CHECK (octet_length(account) = 20),
    CONSTRAINT prepared_action_calldata_hash_length_check CHECK (octet_length(calldata_hash) = 32),
    CONSTRAINT prepared_action_transactions_check
        CHECK (jsonb_typeof(transactions_json) = 'array' AND jsonb_array_length(transactions_json) >= 1),
    CONSTRAINT prepared_action_previewed_check CHECK (previewed_amount >= 0),
    CONSTRAINT prepared_action_sent_count_check
        CHECK (sent_count >= 0 AND sent_count <= jsonb_array_length(transactions_json)),
    -- An action cannot claim to be submitted while one of its calls has no hash. Without this the
    -- approval of a two-call deposit could close the action and strand the deposit.
    CONSTRAINT prepared_action_sent_status_check
        CHECK (
            status NOT IN ('submitted', 'confirmed', 'reverted')
            OR sent_count = jsonb_array_length(transactions_json)
        ),
    -- Only the two terminal-without-execution states carry a reason, and both must. Otherwise an
    -- invalidated action could sit in the table with nothing saying why.
    CONSTRAINT prepared_action_invalidation_check
        CHECK ((status IN ('expired', 'invalidated')) = (invalidated_reason IS NOT NULL)),
    -- Keeps the action on the same chain as the vault it targets.
    CONSTRAINT prepared_action_vault_chain_fk
        FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id),
    -- Composite rather than a plain reference to evidence_report (id): an action on vault A citing
    -- a report about vault B is the exact bug report_observation's own composite keys exist to
    -- prevent (ERD section 11). MATCH SIMPLE, the default, so a NULL report_id still satisfies it
    -- and the nullable-motivation case keeps working.
    CONSTRAINT prepared_action_report_vault_fk
        FOREIGN KEY (report_id, vault_id) REFERENCES evidence_report (id, vault_id)
);

CREATE INDEX IF NOT EXISTS prepared_action_wallet_idx ON prepared_action (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prepared_action_vault_idx ON prepared_action (vault_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prepared_action_report_idx ON prepared_action (report_id);

-- Idempotency, scoped to actions that are still awaiting a signature.
--
-- Preparing the same action twice while the first is still live returns the first rather than
-- accumulating rows a user would have to choose between. Preparing it again after it has been sent
-- mints a new one, because by then it is a new intent to spend.
CREATE UNIQUE INDEX IF NOT EXISTS prepared_action_live_binding_key
    ON prepared_action (calldata_hash)
    WHERE status IN ('prepared', 'simulated');

-- ---------------------------------------------------------------------------------------------
-- Simulation attempts
--
-- Append-only. A resimulation adds a row rather than replacing one, because the question "was this
-- ever simulated successfully, and against which block" has to stay answerable after the action
-- expires.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS simulation (
    id                  UUID          PRIMARY KEY,
    prepared_action_id  TEXT          NOT NULL REFERENCES prepared_action (id),
    -- Which of the action's calls this attempt covered. ERD section 7 describes this table with
    -- one call per action in mind; the approve-then-deposit pair SMART-CONTRACT.md section 4
    -- requires does not fit that, and a simulation that did not say which call it ran would let
    -- an approval's gas figure stand in for the deposit's.
    call_index          INTEGER       NOT NULL,
    block_number        NUMERIC(78,0) NOT NULL,
    block_hash          BYTEA         NOT NULL,
    account             BYTEA         NOT NULL,
    success             BOOLEAN       NOT NULL,
    -- NULL for a call that reverted. There is no gas figure for a transaction that did not happen,
    -- and a zero here would read as a free one.
    gas_estimate        NUMERIC(78,0),
    return_data_hash    BYTEA,
    decoded_result_json JSONB,
    revert_class        TEXT          NOT NULL,
    -- Names the provider. Never a credential.
    provider_key        TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT simulation_call_index_check CHECK (call_index >= 0),
    CONSTRAINT simulation_block_hash_length_check CHECK (octet_length(block_hash) = 32),
    CONSTRAINT simulation_account_length_check CHECK (octet_length(account) = 20),
    CONSTRAINT simulation_return_data_hash_length_check
        CHECK (return_data_hash IS NULL OR octet_length(return_data_hash) = 32),
    CONSTRAINT simulation_gas_estimate_check CHECK (gas_estimate IS NULL OR gas_estimate >= 0),
    CONSTRAINT simulation_revert_class_check
        CHECK (revert_class IN ('none', 'reverted', 'out_of_gas', 'provider_unavailable', 'unclassified')),
    -- A successful simulation has a gas figure and no revert class; a failed one is the other way
    -- round. This is the same "missing evidence stays explicit" rule vault_snapshot.call_errors
    -- enforces one layer down.
    CONSTRAINT simulation_success_shape_check
        CHECK (success = (gas_estimate IS NOT NULL AND revert_class = 'none'))
);

CREATE INDEX IF NOT EXISTS simulation_action_idx ON simulation (prepared_action_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- What the wallet did with it
--
-- One row per *call*, written only when a caller reports a hash. TR4CE never submits and never
-- polls for one; if the user signs and walks away, this table simply has no row.
--
-- Deviation from ERD section 7, which writes `prepared_action_id` UNIQUE. One receipt per action
-- cannot represent the approve-plus-deposit pair that SMART-CONTRACT.md section 4 requires: the
-- approval's hash would either overwrite the deposit's or have nowhere to go, and the deposit would
-- be unreportable. The key is therefore (prepared_action_id, call_index). Recorded here rather than
-- left as an undocumented difference, on the same terms as the content-derived report id in 0002.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transaction_receipt (
    prepared_action_id     TEXT          NOT NULL REFERENCES prepared_action (id),
    call_index             INTEGER       NOT NULL,
    chain_id               BIGINT        NOT NULL,
    transaction_hash       BYTEA         NOT NULL,
    submitted_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    confirmed_block_number NUMERIC(78,0),
    confirmed_block_hash   BYTEA,
    status                 TEXT,
    gas_used               NUMERIC(78,0),
    effective_gas_price    NUMERIC(78,0),
    -- What the vault's own event reported: shares for a deposit, assets for a redemption. NULL when
    -- no matching event was found in the receipt, and never filled in from the preview — "we saw
    -- nothing" and "it matched" are different claims and only one of them would be true.
    actual_amount          NUMERIC(78,0),
    observed_at            TIMESTAMPTZ,
    PRIMARY KEY (prepared_action_id, call_index),
    CONSTRAINT transaction_receipt_call_index_check CHECK (call_index >= 0),
    CONSTRAINT transaction_receipt_actual_amount_check
        CHECK (actual_amount IS NULL OR actual_amount >= 0),
    CONSTRAINT transaction_receipt_hash_length_check CHECK (octet_length(transaction_hash) = 32),
    CONSTRAINT transaction_receipt_block_hash_length_check
        CHECK (confirmed_block_hash IS NULL OR octet_length(confirmed_block_hash) = 32),
    CONSTRAINT transaction_receipt_status_check
        CHECK (status IS NULL OR status IN ('success', 'reverted')),
    -- A hash can be known long before the receipt is. Either every confirmation column is present
    -- or none is, so a half-observed receipt cannot be read as a confirmed one.
    CONSTRAINT transaction_receipt_confirmation_check
        CHECK (
            (confirmed_block_number IS NULL) = (confirmed_block_hash IS NULL) AND
            (confirmed_block_number IS NULL) = (status IS NULL) AND
            (confirmed_block_number IS NULL) = (observed_at IS NULL)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS transaction_receipt_hash_key
    ON transaction_receipt (chain_id, transaction_hash);

-- Row-level security, on the same terms as migration 0003: enabled everywhere, no policy anywhere,
-- table owners exempt. These three tables are the most sensitive in the schema — `prepared_action`
-- ties a wallet address to what it was about to do.
ALTER TABLE prepared_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_receipt ENABLE ROW LEVEL SECURITY;

COMMIT;
