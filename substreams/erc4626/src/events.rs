use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

use crate::abi;
use crate::config::Config;
use crate::pb::tr4ce::v1::{Deposit, EventRef, ShareTransfer, TransferKind, VaultEvents, Withdraw};

pub const SCHEMA_VERSION: &str = "1.0.0";

const ZERO_ADDRESS: [u8; 20] = [0u8; 20];

pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Pure. A share mint or burn is accounting, not an economic transfer between holders.
///
/// These are classified rather than dropped so the evidence engine can prove it excluded them
/// instead of never having seen them.
pub fn classify_transfer(from: &[u8], to: &[u8]) -> TransferKind {
    let from_zero = from == ZERO_ADDRESS;
    let to_zero = to == ZERO_ADDRESS;

    match (from_zero, to_zero) {
        (true, true) => TransferKind::Unspecified,
        (true, false) => TransferKind::Mint,
        (false, true) => TransferKind::Burn,
        (false, false) => TransferKind::Transfer,
    }
}

fn event_ref(chain_id: u64, block: &eth::Block, tx_hash: &[u8], log_index: u32) -> EventRef {
    EventRef {
        chain_id,
        block_hash: block.hash.clone(),
        transaction_hash: tx_hash.to_vec(),
        log_index,
        block_number: block.number,
        block_time: block.header.as_ref().and_then(|h| h.timestamp),
    }
}

/// Decode every curated vault's standardised events out of one block.
///
/// There is no address-specific branch here: the curated set is data supplied through `params`,
/// and every vault flows through the same decoding path.
pub fn extract_events(cfg: &Config, block: &eth::Block) -> VaultEvents {
    let mut deposits = Vec::new();
    let mut withdrawals = Vec::new();
    let mut share_transfers = Vec::new();

    for trx in block.transactions() {
        for (log, _call) in trx.logs_with_calls() {
            // Cheapest possible reject, on raw bytes.
            if !cfg.is_curated(&log.address) {
                continue;
            }

            let vault = hex0x(&log.address);
            let r = event_ref(cfg.chain_id, block, &trx.hash, log.block_index);

            if let Some(e) = abi::erc4626::events::Deposit::match_and_decode(log) {
                deposits.push(Deposit {
                    r#ref: Some(r),
                    vault,
                    sender: hex0x(&e.sender),
                    owner: hex0x(&e.owner),
                    assets: e.assets.to_string(),
                    shares: e.shares.to_string(),
                });
            } else if let Some(e) = abi::erc4626::events::Withdraw::match_and_decode(log) {
                withdrawals.push(Withdraw {
                    r#ref: Some(r),
                    vault,
                    sender: hex0x(&e.sender),
                    receiver: hex0x(&e.receiver),
                    owner: hex0x(&e.owner),
                    assets: e.assets.to_string(),
                    shares: e.shares.to_string(),
                });
            } else if let Some(e) = abi::erc4626::events::Transfer::match_and_decode(log) {
                share_transfers.push(ShareTransfer {
                    r#ref: Some(r),
                    vault,
                    from: hex0x(&e.from),
                    to: hex0x(&e.to),
                    shares: e.value.to_string(),
                    kind: classify_transfer(&e.from, &e.to) as i32,
                });
            }
        }
    }

    VaultEvents {
        chain_id: cfg.chain_id,
        block_number: block.number,
        block_hash: block.hash.clone(),
        block_time: block.header.as_ref().and_then(|h| h.timestamp),
        deposits,
        withdrawals,
        share_transfers,
        schema_version: SCHEMA_VERSION.to_string(),
    }
}

/// Vaults that saw a real economic flow in this block. Share transfers alone do not move vault
/// accounting, so they do not trigger a snapshot.
pub fn active_vaults(events: &VaultEvents) -> Vec<String> {
    let mut active: Vec<String> = events
        .deposits
        .iter()
        .map(|d| d.vault.clone())
        .chain(events.withdrawals.iter().map(|w| w.vault.clone()))
        .collect();
    active.sort();
    active.dedup();
    active
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOLDER_A: [u8; 20] = [0xaa; 20];
    const HOLDER_B: [u8; 20] = [0xbb; 20];

    #[test]
    fn classifies_a_mint_from_the_zero_address() {
        assert_eq!(
            classify_transfer(&ZERO_ADDRESS, &HOLDER_A),
            TransferKind::Mint
        );
    }

    #[test]
    fn classifies_a_burn_to_the_zero_address() {
        assert_eq!(
            classify_transfer(&HOLDER_A, &ZERO_ADDRESS),
            TransferKind::Burn
        );
    }

    #[test]
    fn classifies_a_holder_to_holder_transfer() {
        assert_eq!(
            classify_transfer(&HOLDER_A, &HOLDER_B),
            TransferKind::Transfer
        );
    }

    #[test]
    fn refuses_to_classify_a_zero_to_zero_transfer() {
        // Not a real economic flow in either direction; downstream must not treat it as one.
        assert_eq!(
            classify_transfer(&ZERO_ADDRESS, &ZERO_ADDRESS),
            TransferKind::Unspecified
        );
    }

    #[test]
    fn reports_only_vaults_with_an_economic_flow_as_active() {
        let events = VaultEvents {
            chain_id: 0,
            block_number: 1,
            block_hash: vec![],
            block_time: None,
            deposits: vec![Deposit {
                r#ref: None,
                vault: "0xaaaa".to_string(),
                sender: String::new(),
                owner: String::new(),
                assets: "1".to_string(),
                shares: "1".to_string(),
            }],
            withdrawals: vec![],
            // A share transfer must NOT mark the vault active: it moves no assets in or out.
            share_transfers: vec![ShareTransfer {
                r#ref: None,
                vault: "0xbbbb".to_string(),
                from: String::new(),
                to: String::new(),
                shares: "1".to_string(),
                kind: TransferKind::Transfer as i32,
            }],
            schema_version: SCHEMA_VERSION.to_string(),
        };

        assert_eq!(active_vaults(&events), vec!["0xaaaa".to_string()]);
    }

    #[test]
    fn formats_addresses_as_lowercase_prefixed_hex() {
        assert_eq!(hex0x(&HOLDER_A), format!("0x{}", "aa".repeat(20)));
    }
}
