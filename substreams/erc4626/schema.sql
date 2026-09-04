-- Raw staging schema for the built-in PostgreSQL Database Changes sink.
--
-- Deliberately NOT the constrained application schema in docs/technical/ERD.md. The sink owns
-- these rows and rewrites them during pre-confirmation reorg handling; the promotion worker
-- copies confirmed rows into the application tables, which is where CHECK constraints, uuid
-- surrogate keys, and foreign keys belong.
--
-- Sink constraints observed here:
--   * no CHECK constraints  - a legal-but-unexpected chain value would abort the whole batch
--   * no SERIAL / uuid PKs  - keys must be deterministic so replay is idempotent
--   * no cross-table FKs    - per-table flush order is not guaranteed
--   * NUMERIC(78,0) amounts - uint256 overflows BIGINT
--
-- The sink creates and owns its own `cursors` and `substreams_history` tables; never hand-roll
-- them.
--
-- ERD section 1.1 asks for a dedicated `raw_erc4626` schema. The sink gives no way to get one:
-- there is no --schema flag, a `?schema=` DSN parameter is rejected outright by Postgres, a
-- `search_path=` DSN parameter is accepted and then ignored for DDL, and the sink quotes table
-- identifiers so `raw_erc4626.deposit` would be created as one literal name. The namespace is
-- therefore carried in the table name instead. The separation ERD wants -- raw staging kept apart
-- from the application tables the promotion worker writes -- still holds.

CREATE TABLE IF NOT EXISTS raw_erc4626_deposit (
    chain_id          BIGINT        NOT NULL,
    block_hash        VARCHAR(66)   NOT NULL,
    transaction_hash  VARCHAR(66)   NOT NULL,
    log_index         INTEGER       NOT NULL,
    block_number      BIGINT        NOT NULL,
    block_time        TIMESTAMPTZ   NOT NULL,
    vault             VARCHAR(42)   NOT NULL,
    sender            VARCHAR(42)   NOT NULL,
    owner             VARCHAR(42)   NOT NULL,
    assets            NUMERIC(78,0) NOT NULL,
    shares            NUMERIC(78,0) NOT NULL,
    schema_version    TEXT          NOT NULL,
    PRIMARY KEY (chain_id, block_hash, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS raw_erc4626_withdraw (
    chain_id          BIGINT        NOT NULL,
    block_hash        VARCHAR(66)   NOT NULL,
    transaction_hash  VARCHAR(66)   NOT NULL,
    log_index         INTEGER       NOT NULL,
    block_number      BIGINT        NOT NULL,
    block_time        TIMESTAMPTZ   NOT NULL,
    vault             VARCHAR(42)   NOT NULL,
    sender            VARCHAR(42)   NOT NULL,
    receiver          VARCHAR(42)   NOT NULL,
    owner             VARCHAR(42)   NOT NULL,
    assets            NUMERIC(78,0) NOT NULL,
    shares            NUMERIC(78,0) NOT NULL,
    schema_version    TEXT          NOT NULL,
    PRIMARY KEY (chain_id, block_hash, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS raw_erc4626_share_transfer (
    chain_id          BIGINT        NOT NULL,
    block_hash        VARCHAR(66)   NOT NULL,
    transaction_hash  VARCHAR(66)   NOT NULL,
    log_index         INTEGER       NOT NULL,
    block_number      BIGINT        NOT NULL,
    block_time        TIMESTAMPTZ   NOT NULL,
    vault             VARCHAR(42)   NOT NULL,
    from_address      VARCHAR(42)   NOT NULL,
    to_address        VARCHAR(42)   NOT NULL,
    shares            NUMERIC(78,0) NOT NULL,
    -- 'transfer' | 'mint' | 'burn' | 'unspecified'. Mints and burns are recorded, not dropped, so
    -- the evidence engine can prove it excluded them from economic flow.
    transfer_kind     TEXT          NOT NULL,
    schema_version    TEXT          NOT NULL,
    PRIMARY KEY (chain_id, block_hash, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS raw_erc4626_vault_snapshot (
    chain_id           BIGINT        NOT NULL,
    vault              VARCHAR(42)   NOT NULL,
    block_hash         VARCHAR(66)   NOT NULL,
    schema_version     TEXT          NOT NULL,
    block_number       BIGINT        NOT NULL,
    block_time         TIMESTAMPTZ   NOT NULL,
    asset              VARCHAR(42)   NOT NULL,
    share_decimals     SMALLINT      NOT NULL,
    asset_decimals     SMALLINT      NOT NULL,
    -- Nullable on purpose: NULL means the call produced no usable value. It never means zero.
    total_assets       NUMERIC(78,0),
    total_supply       NUMERIC(78,0),
    one_share_units    NUMERIC(78,0) NOT NULL,
    one_share_assets   NUMERIC(78,0),
    call_status        TEXT          NOT NULL,
    -- TEXT, not JSONB: the Database Changes sink emits a JSONB value unquoted, producing
    -- `VALUES (..., [], ...)` and a SQL syntax error. The JSON is stored verbatim here and the
    -- promotion worker casts it when it writes the application table, where ERD asks for jsonb.
    call_errors        TEXT          NOT NULL DEFAULT '[]',
    trigger_activity   BOOLEAN       NOT NULL,
    trigger_checkpoint BOOLEAN       NOT NULL,
    trigger_anchor     BOOLEAN       NOT NULL,
    -- ERD keys this on (vault_id, block_hash, schema_version). vault_id is a uuid surrogate in the
    -- application schema, which raw staging does not own, so the vault address stands in here and
    -- the promotion worker maps address -> vault_id.
    PRIMARY KEY (chain_id, vault, block_hash, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_deposit_vault_block   ON raw_erc4626_deposit (chain_id, vault, block_number);
CREATE INDEX IF NOT EXISTS idx_withdraw_vault_block  ON raw_erc4626_withdraw (chain_id, vault, block_number);
CREATE INDEX IF NOT EXISTS idx_transfer_vault_block  ON raw_erc4626_share_transfer (chain_id, vault, block_number);
CREATE INDEX IF NOT EXISTS idx_snapshot_vault_block  ON raw_erc4626_vault_snapshot (chain_id, vault, block_number);
