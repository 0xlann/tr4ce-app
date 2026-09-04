use std::collections::BTreeMap;

/// One curated vault, supplied at runtime rather than compiled in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuratedVault {
    pub address: [u8; 20],
    pub asset: [u8; 20],
    pub share_decimals: u32,
    pub asset_decimals: u32,
}

/// Runtime configuration parsed from the module `params` input.
///
/// Format:
/// `chain_id=<n>&anchor_block=<n>&checkpoint_interval=<n>&vaults=<vault>:<asset>:<shareDec>:<assetDec>,...`
///
/// Addresses may be given with or without a `0x` prefix and in any case; they are normalised to
/// raw lowercase bytes. Comparison never happens on formatted strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub chain_id: u64,
    /// First block of the declared observation window. Snapshotted unconditionally so a start
    /// observation always exists, even when that block is quiet.
    pub anchor_block: u64,
    pub vaults: Vec<CuratedVault>,
    pub checkpoint_interval: u64,
}

impl Config {
    pub fn parse(params: &str) -> Result<Self, String> {
        let mut fields: BTreeMap<&str, &str> = BTreeMap::new();
        for pair in params.split('&').filter(|p| !p.is_empty()) {
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| format!("params field is not key=value: {pair}"))?;
            fields.insert(key.trim(), value.trim());
        }

        let chain_id = match fields.get("chain_id") {
            None => return Err("params is missing chain_id".to_string()),
            Some(raw) => raw
                .parse::<u64>()
                .map_err(|_| format!("chain_id is not an integer: {raw}"))?,
        };
        if chain_id == 0 {
            return Err("chain_id must be greater than zero".to_string());
        }

        let anchor_block = match fields.get("anchor_block") {
            None => return Err("params is missing anchor_block".to_string()),
            Some(raw) => raw
                .parse::<u64>()
                .map_err(|_| format!("anchor_block is not an integer: {raw}"))?,
        };

        let checkpoint_interval = match fields.get("checkpoint_interval") {
            None => return Err("params is missing checkpoint_interval".to_string()),
            Some(raw) => raw
                .parse::<u64>()
                .map_err(|_| format!("checkpoint_interval is not an integer: {raw}"))?,
        };
        if checkpoint_interval == 0 {
            return Err("checkpoint_interval must be greater than zero".to_string());
        }

        let raw_vaults = fields
            .get("vaults")
            .ok_or_else(|| "params is missing vaults".to_string())?;

        let mut vaults = Vec::new();
        for entry in raw_vaults.split(',').filter(|e| !e.is_empty()) {
            vaults.push(parse_vault(entry)?);
        }
        if vaults.is_empty() {
            return Err("params declared no curated vaults".to_string());
        }

        vaults.sort_by(|a, b| a.address.cmp(&b.address));
        vaults.dedup_by(|a, b| a.address == b.address);

        Ok(Config {
            chain_id,
            anchor_block,
            vaults,
            checkpoint_interval,
        })
    }

    #[inline]
    pub fn vault(&self, address: &[u8]) -> Option<&CuratedVault> {
        if address.len() != 20 {
            return None;
        }
        self.vaults.iter().find(|v| v.address.as_slice() == address)
    }

    #[inline]
    pub fn is_curated(&self, address: &[u8]) -> bool {
        self.vault(address).is_some()
    }
}

fn parse_vault(entry: &str) -> Result<CuratedVault, String> {
    let parts: Vec<&str> = entry.split(':').collect();
    if parts.len() != 4 {
        return Err(format!(
            "vault entry must be <vault>:<asset>:<shareDecimals>:<assetDecimals>, got: {entry}"
        ));
    }

    let address = parse_address(parts[0])?;
    let asset = parse_address(parts[1])?;
    let share_decimals = parse_decimals(parts[2])?;
    let asset_decimals = parse_decimals(parts[3])?;

    Ok(CuratedVault {
        address,
        asset,
        share_decimals,
        asset_decimals,
    })
}

fn parse_address(raw: &str) -> Result<[u8; 20], String> {
    let stripped = raw.strip_prefix("0x").unwrap_or(raw);
    if stripped.len() != 40 {
        return Err(format!("address must be 20 bytes of hex, got: {raw}"));
    }
    let bytes = hex::decode(stripped).map_err(|_| format!("address is not valid hex: {raw}"))?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn parse_decimals(raw: &str) -> Result<u32, String> {
    let value = raw
        .parse::<u32>()
        .map_err(|_| format!("decimals is not an unsigned integer: {raw}"))?;
    // One-share units are 10^decimals; anything beyond 77 overflows a uint256.
    if value > 77 {
        return Err(format!("decimals out of supported range: {raw}"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS: &str = "chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=\
        1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6";

    #[test]
    fn parses_a_single_vault() {
        let cfg = Config::parse(PARAMS).expect("params should parse");

        assert_eq!(cfg.chain_id, 8453);
        assert_eq!(cfg.anchor_block, 1000);
        assert_eq!(cfg.checkpoint_interval, 1800);
        assert_eq!(cfg.vaults.len(), 1);
        assert_eq!(cfg.vaults[0].share_decimals, 18);
        assert_eq!(cfg.vaults[0].asset_decimals, 6);
    }

    #[test]
    fn normalises_prefixed_and_mixed_case_addresses() {
        let mixed = "chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=\
            0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa:0xbBbB000000000000000000000000000000000000:18:6";
        let cfg = Config::parse(mixed).expect("params should parse");

        // A checksummed literal must still match raw lowercase bytes.
        assert!(cfg.is_curated(&[0xaa; 20]));
    }

    #[test]
    fn deduplicates_repeated_vaults() {
        let repeated = format!("{PARAMS},1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6");
        let cfg = Config::parse(&repeated).expect("params should parse");

        assert_eq!(cfg.vaults.len(), 1);
    }

    #[test]
    fn rejects_malformed_input_instead_of_panicking() {
        // A silently wrong address set produces a plausible-looking empty stream, so every one of
        // these must be a loud error.
        assert!(Config::parse("").is_err(), "empty params");
        assert!(Config::parse("chain_id=8453&anchor_block=1000&vaults=1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6").is_err(), "missing checkpoint_interval");
        assert!(Config::parse("chain_id=8453&anchor_block=1000&checkpoint_interval=0&vaults=1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6").is_err(), "zero interval");
        assert!(
            Config::parse("chain_id=8453&anchor_block=1000&checkpoint_interval=1800").is_err(),
            "missing vaults"
        );
        assert!(Config::parse("checkpoint_interval=1800&vaults=1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6").is_err(), "missing chain_id");
        assert!(Config::parse("chain_id=8453&checkpoint_interval=1800&vaults=1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6").is_err(), "missing anchor_block");
        assert!(
            Config::parse("chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=")
                .is_err(),
            "no vault entries"
        );
        assert!(
            Config::parse(
                "chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=1111:2222:18:6"
            )
            .is_err(),
            "short address"
        );
        assert!(Config::parse("chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=zzzz111111111111111111111111111111111111:2222222222222222222222222222222222222222:18:6").is_err(), "non-hex address");
        assert!(Config::parse("chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:18").is_err(), "missing field");
        assert!(Config::parse("chain_id=8453&anchor_block=1000&checkpoint_interval=1800&vaults=1111111111111111111111111111111111111111:2222222222222222222222222222222222222222:999:6").is_err(), "decimals overflow");
    }

    #[test]
    fn does_not_match_a_wrong_length_address() {
        let cfg = Config::parse(PARAMS).expect("params should parse");

        assert!(!cfg.is_curated(&[0x11; 19]));
        assert!(!cfg.is_curated(&[0x11; 21]));
    }
}
