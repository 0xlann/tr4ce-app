use substreams::scalar::BigInt;
use substreams_ethereum::rpc::RpcBatch;

use crate::abi;
use crate::config::{Config, CuratedVault};
use crate::pb::tr4ce::v1::{CallError, CallStatus, SnapshotTrigger};

/// A decision to snapshot one vault at one block, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPlan {
    pub vault: [u8; 20],
    pub trigger: SnapshotTrigger,
}

/// Pure. Decides which vaults to snapshot at this block and records the reason.
///
/// The checkpoint test is a stateless modulo on the block number rather than a running counter,
/// so replaying a range produces identical rows and the backfill still parallelises under
/// production mode.
pub fn plan_snapshots(
    block_number: u64,
    cfg: &Config,
    active_vaults: &[String],
) -> Vec<SnapshotPlan> {
    let checkpoint = block_number.is_multiple_of(cfg.checkpoint_interval);
    let window_anchor = block_number == cfg.anchor_block;

    cfg.vaults
        .iter()
        .filter_map(|v| {
            let formatted = format!("0x{}", hex::encode(v.address));
            let activity = active_vaults.iter().any(|a| a == &formatted);

            if !(activity || checkpoint || window_anchor) {
                return None;
            }

            Some(SnapshotPlan {
                vault: v.address,
                trigger: SnapshotTrigger {
                    activity,
                    checkpoint,
                    window_anchor,
                },
            })
        })
        .collect()
}

/// Outcome of the four block-scoped reads. `None` means the call produced no usable value; it
/// never means zero.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReadResults {
    pub total_assets: Option<BigInt>,
    pub total_supply: Option<BigInt>,
    pub decimals: Option<BigInt>,
    pub one_share_assets: Option<BigInt>,
}

/// Pure. Grades a set of block-scoped reads and names every method that failed.
///
/// `expected_decimals` comes from the reviewed vault manifest. A vault that reports different
/// decimals on chain than the manifest recorded is an implementation change, not a value to be
/// silently trusted, so it degrades the snapshot to `partial`.
pub fn classify(results: &ReadResults, expected_decimals: u32) -> (CallStatus, Vec<CallError>) {
    let mut errors = Vec::new();

    if results.total_assets.is_none() {
        errors.push(reverted("totalAssets"));
    }
    if results.total_supply.is_none() {
        errors.push(reverted("totalSupply"));
    }
    if results.decimals.is_none() {
        errors.push(reverted("decimals"));
    }
    if results.one_share_assets.is_none() {
        errors.push(reverted("convertToAssets"));
    }

    let all_failed = errors.len() == 4;

    if let Some(observed) = &results.decimals {
        if observed != &BigInt::from(expected_decimals as u64) {
            errors.push(CallError {
                method: "decimals".to_string(),
                classification: "manifest_mismatch".to_string(),
            });
        }
    }

    let status = if errors.is_empty() {
        CallStatus::Ok
    } else if all_failed {
        CallStatus::Reverted
    } else {
        CallStatus::Partial
    };

    (status, errors)
}

fn reverted(method: &str) -> CallError {
    CallError {
        method: method.to_string(),
        classification: "reverted".to_string(),
    }
}

/// Serialise a decoded value for the wire. An absent value becomes an empty string, never "0".
pub fn wire(value: &Option<BigInt>) -> String {
    value.as_ref().map(|v| v.to_string()).unwrap_or_default()
}

pub fn one_share_units(share_decimals: u32) -> BigInt {
    BigInt::from(10).pow(share_decimals)
}

/// The RPC boundary. Batches all four block-scoped reads into a single round trip and never
/// panics: a reverting vault degrades its own snapshot and leaves every other vault untouched.
pub fn execute(vault: &CuratedVault) -> (ReadResults, Vec<CallError>) {
    let address = vault.address.to_vec();
    let one_share = one_share_units(vault.share_decimals);

    let batch = RpcBatch::new()
        .add(abi::erc4626::functions::TotalAssets {}, address.clone())
        .add(abi::erc4626::functions::TotalSupply {}, address.clone())
        .add(abi::erc4626::functions::Decimals {}, address.clone())
        .add(
            abi::erc4626::functions::ConvertToAssets { shares: one_share },
            address,
        )
        .execute();

    match batch {
        // execute() yields Result<_, String>, not substreams::errors::Error. A transport failure
        // is recorded, not propagated: it must not abort the whole block.
        Err(_) => (
            ReadResults::default(),
            vec![CallError {
                method: "*".to_string(),
                classification: "batch_failed".to_string(),
            }],
        ),
        Ok(response) => {
            // responses[i] follows .add() order exactly; decode yields None on revert or on a
            // non-compliant return, and must never be unwrapped.
            let results = ReadResults {
                total_assets: RpcBatch::decode::<_, abi::erc4626::functions::TotalAssets>(
                    &response.responses[0],
                ),
                total_supply: RpcBatch::decode::<_, abi::erc4626::functions::TotalSupply>(
                    &response.responses[1],
                ),
                decimals: RpcBatch::decode::<_, abi::erc4626::functions::Decimals>(
                    &response.responses[2],
                ),
                one_share_assets: RpcBatch::decode::<_, abi::erc4626::functions::ConvertToAssets>(
                    &response.responses[3],
                ),
            };
            let (_, errors) = classify(&results, vault.share_decimals);
            (results, errors)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(interval: u64) -> Config {
        Config::parse(&format!(
            "chain_id=8453&anchor_block=1000&checkpoint_interval={interval}&vaults=\
             1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6"
        ))
        .expect("params should parse")
    }

    const VAULT: &str = "0x1111111111111111111111111111111111111111";

    #[test]
    fn snapshots_a_quiet_block_only_on_a_checkpoint() {
        let cfg = config(1800);

        assert!(plan_snapshots(1801, &cfg, &[]).is_empty());

        let planned = plan_snapshots(3600, &cfg, &[]);
        assert_eq!(planned.len(), 1);
        assert!(planned[0].trigger.checkpoint);
        assert!(!planned[0].trigger.activity);
    }

    #[test]
    fn snapshots_an_active_vault_between_checkpoints() {
        let cfg = config(1800);
        let planned = plan_snapshots(1801, &cfg, &[VAULT.to_string()]);

        assert_eq!(planned.len(), 1);
        assert!(planned[0].trigger.activity);
        assert!(!planned[0].trigger.checkpoint);
    }

    #[test]
    fn always_snapshots_the_window_anchor_so_a_start_observation_exists() {
        let cfg = config(1800);
        // A quiet, non-checkpoint block that happens to be the declared window start.
        let planned = plan_snapshots(1000, &cfg, &[]);

        assert_eq!(planned.len(), 1);
        assert!(planned[0].trigger.window_anchor);
    }

    #[test]
    fn grades_a_fully_successful_read_as_ok() {
        let results = ReadResults {
            total_assets: Some(BigInt::from(100u64)),
            total_supply: Some(BigInt::from(90u64)),
            decimals: Some(BigInt::from(18u64)),
            one_share_assets: Some(BigInt::from(1u64)),
        };
        let (status, errors) = classify(&results, 18);

        assert_eq!(status, CallStatus::Ok);
        assert!(errors.is_empty());
    }

    #[test]
    fn grades_a_single_failed_method_as_partial_and_names_it() {
        let results = ReadResults {
            total_assets: Some(BigInt::from(100u64)),
            total_supply: Some(BigInt::from(90u64)),
            decimals: Some(BigInt::from(18u64)),
            one_share_assets: None,
        };
        let (status, errors) = classify(&results, 18);

        assert_eq!(status, CallStatus::Partial);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].method, "convertToAssets");
        assert_eq!(errors[0].classification, "reverted");
    }

    #[test]
    fn grades_a_wholly_reverting_vault_as_reverted() {
        let (status, errors) = classify(&ReadResults::default(), 18);

        assert_eq!(status, CallStatus::Reverted);
        assert_eq!(errors.len(), 4);
    }

    #[test]
    fn degrades_a_snapshot_when_on_chain_decimals_contradict_the_manifest() {
        let results = ReadResults {
            total_assets: Some(BigInt::from(100u64)),
            total_supply: Some(BigInt::from(90u64)),
            decimals: Some(BigInt::from(6u64)),
            one_share_assets: Some(BigInt::from(1u64)),
        };
        let (status, errors) = classify(&results, 18);

        assert_eq!(status, CallStatus::Partial);
        assert_eq!(errors[0].classification, "manifest_mismatch");
    }

    #[test]
    fn never_serialises_an_absent_value_as_zero() {
        assert_eq!(wire(&None), "");
        assert_eq!(wire(&Some(BigInt::from(0u64))), "0");
    }

    #[test]
    fn computes_one_share_units_from_share_decimals() {
        assert_eq!(one_share_units(6), BigInt::from(1_000_000u64));
        assert_eq!(one_share_units(18).to_string(), "1000000000000000000");
    }
}
