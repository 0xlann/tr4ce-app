// The handler macros expand to extern "C" entry points that clippy flags as raw-pointer
// dereferences; that is inherent to the Substreams ABI, not a defect in this code.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod abi;
mod config;
mod db_out;
mod events;
mod snapshots;

pub mod pb {
    pub mod tr4ce {
        pub mod v1 {
            include!(concat!(env!("OUT_DIR"), "/tr4ce.v1.rs"));
        }
    }
}

use substreams::errors::Error;
use substreams_database_change::pb::sf::substreams::sink::database::v1::DatabaseChanges;
use substreams_ethereum::pb::eth::v2 as eth;

use crate::config::Config;
use crate::events::SCHEMA_VERSION;
use crate::pb::tr4ce::v1::{VaultBlockBatch, VaultEvents, VaultSnapshot};

/// Decode the standardised ERC-4626 events emitted by every curated vault in this block.
///
/// Pure with respect to the chain: no contract calls happen here, which is what keeps this
/// handler testable offline against recorded block fixtures.
#[substreams::handlers::map]
fn map_vault_events(params: String, block: eth::Block) -> Result<VaultEvents, Error> {
    let cfg = Config::parse(&params).map_err(Error::msg)?;

    Ok(events::extract_events(&cfg, &block))
}

/// Assemble the block batch: decoded flows plus any block-scoped vault snapshots this block calls
/// for.
#[substreams::handlers::map]
fn map_vault_block_batch(
    params: String,
    block: eth::Block,
    decoded: VaultEvents,
) -> Result<VaultBlockBatch, Error> {
    let cfg = Config::parse(&params).map_err(Error::msg)?;

    let active = events::active_vaults(&decoded);
    let block_time = block.header.as_ref().and_then(|h| h.timestamp);

    let mut snapshots_out = Vec::new();
    for plan in snapshots::plan_snapshots(block.number, &cfg, &active) {
        // plan_snapshots only ever yields vaults drawn from the config, so this lookup holds.
        let vault = match cfg.vault(&plan.vault) {
            Some(v) => v,
            None => continue,
        };

        let (results, call_errors) = snapshots::execute(vault);
        let (call_status, _) = snapshots::classify(&results, vault.share_decimals);

        snapshots_out.push(VaultSnapshot {
            chain_id: cfg.chain_id,
            block_number: block.number,
            block_hash: block.hash.clone(),
            block_time,
            vault: events::hex0x(&vault.address),
            asset: events::hex0x(&vault.asset),
            share_decimals: vault.share_decimals,
            asset_decimals: vault.asset_decimals,
            total_assets: snapshots::wire(&results.total_assets),
            total_supply: snapshots::wire(&results.total_supply),
            one_share_units: snapshots::one_share_units(vault.share_decimals).to_string(),
            one_share_assets: snapshots::wire(&results.one_share_assets),
            call_status: call_status as i32,
            call_errors,
            trigger: Some(plan.trigger),
            schema_version: SCHEMA_VERSION.to_string(),
        });
    }

    Ok(VaultBlockBatch {
        chain_id: cfg.chain_id,
        block_number: block.number,
        block_hash: block.hash.clone(),
        block_time,
        deposits: decoded.deposits,
        withdrawals: decoded.withdrawals,
        share_transfers: decoded.share_transfers,
        snapshots: snapshots_out,
        schema_version: SCHEMA_VERSION.to_string(),
    })
}

/// Mirror the block batch into the reorg-aware raw staging schema.
#[substreams::handlers::map]
fn db_out(batch: VaultBlockBatch) -> Result<DatabaseChanges, Error> {
    Ok(db_out::build(&batch))
}
