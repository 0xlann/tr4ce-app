use substreams_database_change::pb::sf::substreams::sink::database::v1::DatabaseChanges;
use substreams_database_change::tables::Tables;

use crate::events::hex0x;
use crate::pb::tr4ce::v1::{CallError, CallStatus, TransferKind, VaultBlockBatch};

/// Primary keys, kept beside the code that builds them. Column names and order must match the
/// PRIMARY KEY declarations in schema.sql exactly; a drift test asserts that.
pub const EVENT_PK: [&str; 4] = ["chain_id", "block_hash", "transaction_hash", "log_index"];
pub const SNAPSHOT_PK: [&str; 4] = ["chain_id", "vault", "block_hash", "schema_version"];

pub fn call_status_label(status: i32) -> &'static str {
    match CallStatus::try_from(status) {
        Ok(CallStatus::Ok) => "ok",
        Ok(CallStatus::Partial) => "partial",
        Ok(CallStatus::Reverted) => "reverted",
        _ => "unspecified",
    }
}

pub fn transfer_kind_label(kind: i32) -> &'static str {
    match TransferKind::try_from(kind) {
        Ok(TransferKind::Transfer) => "transfer",
        Ok(TransferKind::Mint) => "mint",
        Ok(TransferKind::Burn) => "burn",
        _ => "unspecified",
    }
}

/// Serialise per-method failures as a JSON array for the JSONB column.
pub fn call_errors_json(errors: &[CallError]) -> String {
    let body = errors
        .iter()
        .map(|e| {
            format!(
                r#"{{"method":"{}","classification":"{}"}}"#,
                escape(&e.method),
                escape(&e.classification)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("[{body}]")
}

fn escape(value: &str) -> String {
    value.replace('\\', r"\\").replace('"', r#"\""#)
}

fn rfc3339(seconds: i64) -> String {
    // Postgres parses an epoch-seconds timestamptz literal directly; avoiding a date library keeps
    // the wasm module small and the conversion exact.
    format!("{seconds}")
}

pub fn build(batch: &VaultBlockBatch) -> DatabaseChanges {
    let mut tables = Tables::new();

    let chain_id = batch.chain_id.to_string();
    let block_hash = hex0x(&batch.block_hash);
    let block_number = batch.block_number.to_string();
    let block_time = rfc3339(
        batch
            .block_time
            .as_ref()
            .map(|t| t.seconds)
            .unwrap_or_default(),
    );
    let schema_version = batch.schema_version.clone();

    for d in &batch.deposits {
        let r = match &d.r#ref {
            Some(r) => r,
            None => continue,
        };
        let tx = hex0x(&r.transaction_hash);
        let log_index = r.log_index.to_string();
        tables
            .create_row(
                "raw_erc4626_deposit",
                [
                    (EVENT_PK[0], chain_id.as_str()),
                    (EVENT_PK[1], block_hash.as_str()),
                    (EVENT_PK[2], tx.as_str()),
                    (EVENT_PK[3], log_index.as_str()),
                ],
            )
            .set("block_number", block_number.as_str())
            .set("block_time", block_time.as_str())
            .set("vault", d.vault.as_str())
            .set("sender", d.sender.as_str())
            .set("owner", d.owner.as_str())
            .set("assets", d.assets.as_str())
            .set("shares", d.shares.as_str())
            .set("schema_version", schema_version.as_str());
    }

    for w in &batch.withdrawals {
        let r = match &w.r#ref {
            Some(r) => r,
            None => continue,
        };
        let tx = hex0x(&r.transaction_hash);
        let log_index = r.log_index.to_string();
        tables
            .create_row(
                "raw_erc4626_withdraw",
                [
                    (EVENT_PK[0], chain_id.as_str()),
                    (EVENT_PK[1], block_hash.as_str()),
                    (EVENT_PK[2], tx.as_str()),
                    (EVENT_PK[3], log_index.as_str()),
                ],
            )
            .set("block_number", block_number.as_str())
            .set("block_time", block_time.as_str())
            .set("vault", w.vault.as_str())
            .set("sender", w.sender.as_str())
            .set("receiver", w.receiver.as_str())
            .set("owner", w.owner.as_str())
            .set("assets", w.assets.as_str())
            .set("shares", w.shares.as_str())
            .set("schema_version", schema_version.as_str());
    }

    for t in &batch.share_transfers {
        let r = match &t.r#ref {
            Some(r) => r,
            None => continue,
        };
        let tx = hex0x(&r.transaction_hash);
        let log_index = r.log_index.to_string();
        tables
            .create_row(
                "raw_erc4626_share_transfer",
                [
                    (EVENT_PK[0], chain_id.as_str()),
                    (EVENT_PK[1], block_hash.as_str()),
                    (EVENT_PK[2], tx.as_str()),
                    (EVENT_PK[3], log_index.as_str()),
                ],
            )
            .set("block_number", block_number.as_str())
            .set("block_time", block_time.as_str())
            .set("vault", t.vault.as_str())
            .set("from_address", t.from.as_str())
            .set("to_address", t.to.as_str())
            .set("shares", t.shares.as_str())
            .set("transfer_kind", transfer_kind_label(t.kind))
            .set("schema_version", schema_version.as_str());
    }

    for s in &batch.snapshots {
        let trigger = s.trigger.unwrap_or_default();
        let errors = call_errors_json(&s.call_errors);
        let row = tables.create_row(
            "raw_erc4626_vault_snapshot",
            [
                (SNAPSHOT_PK[0], chain_id.as_str()),
                (SNAPSHOT_PK[1], s.vault.as_str()),
                (SNAPSHOT_PK[2], block_hash.as_str()),
                (SNAPSHOT_PK[3], s.schema_version.as_str()),
            ],
        );
        row.set("block_number", block_number.as_str())
            .set("block_time", block_time.as_str())
            .set("asset", s.asset.as_str())
            .set("share_decimals", s.share_decimals.to_string().as_str())
            .set("asset_decimals", s.asset_decimals.to_string().as_str())
            .set("one_share_units", s.one_share_units.as_str())
            .set("call_status", call_status_label(s.call_status))
            .set("call_errors", errors.as_str())
            .set("trigger_activity", bool_label(trigger.activity))
            .set("trigger_checkpoint", bool_label(trigger.checkpoint))
            .set("trigger_anchor", bool_label(trigger.window_anchor));

        // Only write a numeric when a value actually exists. An empty string is not a NUMERIC, and
        // writing "0" would turn a failed call into fabricated evidence.
        if !s.total_assets.is_empty() {
            row.set("total_assets", s.total_assets.as_str());
        }
        if !s.total_supply.is_empty() {
            row.set("total_supply", s.total_supply.as_str());
        }
        if !s.one_share_assets.is_empty() {
            row.set("one_share_assets", s.one_share_assets.as_str());
        }
    }

    tables.to_database_changes()
}

fn bool_label(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = include_str!("../schema.sql");

    /// Extract the PRIMARY KEY column list declared for one table in schema.sql.
    fn declared_pk(table: &str) -> Vec<String> {
        let start = SCHEMA
            .find(&format!("CREATE TABLE IF NOT EXISTS {table} ("))
            .unwrap_or_else(|| panic!("schema.sql has no table {table}"));
        let body = &SCHEMA[start..];
        let pk_line = body
            .lines()
            .find(|l| l.trim_start().starts_with("PRIMARY KEY"))
            .unwrap_or_else(|| panic!("table {table} declares no PRIMARY KEY"));
        let inner = pk_line
            .trim()
            .trim_start_matches("PRIMARY KEY")
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim_end_matches(',')
            .trim_end_matches(')');
        inner.split(',').map(|c| c.trim().to_string()).collect()
    }

    #[test]
    fn event_primary_keys_match_the_schema_exactly() {
        // Names AND order must agree; the sink builds a composite key positionally.
        for table in [
            "raw_erc4626_deposit",
            "raw_erc4626_withdraw",
            "raw_erc4626_share_transfer",
        ] {
            assert_eq!(declared_pk(table), EVENT_PK.to_vec(), "table {table}");
        }
    }

    #[test]
    fn snapshot_primary_key_matches_the_schema_exactly() {
        assert_eq!(
            declared_pk("raw_erc4626_vault_snapshot"),
            SNAPSHOT_PK.to_vec()
        );
    }

    #[test]
    fn labels_every_call_status_and_transfer_kind() {
        assert_eq!(call_status_label(CallStatus::Ok as i32), "ok");
        assert_eq!(call_status_label(CallStatus::Partial as i32), "partial");
        assert_eq!(call_status_label(CallStatus::Reverted as i32), "reverted");
        assert_eq!(
            call_status_label(CallStatus::Unspecified as i32),
            "unspecified"
        );

        assert_eq!(transfer_kind_label(TransferKind::Mint as i32), "mint");
        assert_eq!(transfer_kind_label(TransferKind::Burn as i32), "burn");
        assert_eq!(
            transfer_kind_label(TransferKind::Transfer as i32),
            "transfer"
        );
    }

    #[test]
    fn serialises_call_errors_as_a_json_array() {
        assert_eq!(call_errors_json(&[]), "[]");
        assert_eq!(
            call_errors_json(&[CallError {
                method: "convertToAssets".to_string(),
                classification: "reverted".to_string(),
            }]),
            r#"[{"method":"convertToAssets","classification":"reverted"}]"#
        );
    }
}
