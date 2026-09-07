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
    -- `act_` plus a digest of the binding. Content-derived for the same reason evidence_report.id
    -- is: preparing the same action twice under the same conditions names the same action.
    id                  TEXT          PRIMARY KEY,
    wallet_id           UUID          NOT NULL REFERENCES wallet (id),
    vault_id            UUID          NOT NULL REFERENCES vault (id),
    -- Nullable motivation. An action can be prepared without a report having asked for it, and a
    -- report is evidence rather than a precondition.
    report_id           TEXT          REFERENCES evidence_report (id),
    kind                TEXT          NOT NULL,
    chain_id            BIGINT        NOT NULL,
    account             BYTEA         NOT NULL,
    -- The binding digest: chain, account, target, calldata, value, block, capability version.
    -- ERD section 7 calls it "immutable action identity", and it is what makes a changed field
    -- detectable rather than merely unlikely.
    calldata_hash       BYTEA         NOT NULL,
    -- Every unsigned call, in signing order. A deposit is two when the allowance falls short and
    -- one when it does not, so the count is an observation rather than a constant.
    transactions_json   JSONB         NOT NULL,
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
    -- Only the two terminal-without-execution states carry a reason, and both must. Otherwise an
    -- invalidated action could sit in the table with nothing saying why.
    CONSTRAINT prepared_action_invalidation_check
        CHECK ((status IN ('expired', 'invalidated')) = (invalidated_reason IS NOT NULL)),
    -- Keeps the action on the same chain as the vault it targets.
    CONSTRAINT prepared_action_vault_chain_fk
        FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id)
);

CREATE INDEX IF NOT EXISTS prepared_action_wallet_idx ON prepared_action (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prepared_action_vault_idx ON prepared_action (vault_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prepared_action_report_idx ON prepared_action (report_id);

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
-- One row per prepared action, written only when a caller reports a hash. TR4CE never submits and
-- never polls for one; if the user signs and walks away, this table simply has no row.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transaction_receipt (
    prepared_action_id     TEXT          PRIMARY KEY REFERENCES prepared_action (id),
    chain_id               BIGINT        NOT NULL,
    transaction_hash       BYTEA         NOT NULL,
    submitted_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    confirmed_block_number NUMERIC(78,0),
    confirmed_block_hash   BYTEA,
    status                 TEXT,
    gas_used               NUMERIC(78,0),
    effective_gas_price    NUMERIC(78,0),
    observed_at            TIMESTAMPTZ,
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
