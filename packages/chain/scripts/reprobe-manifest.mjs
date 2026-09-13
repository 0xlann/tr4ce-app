/**
 * Re-probe the curated vault manifest and correct capability evidence.
 *
 * Two defects put false capability evidence into the manifest, and this corrects both.
 *
 * The first was throughput. The original onboarding run went through the public Base endpoint,
 * which throttles a burst of calls. A throttled call returns nothing, and the gate could not tell
 * that apart from a revert — so it recorded `status: "reverted"` for methods the chain answers
 * perfectly well.
 *
 * The second was worse, because it invented an anomaly rather than losing an answer. The gate read
 * the probe owner's share balance once, at the head, and applied it to both probe blocks. The probe
 * owner is discovered from the vault's earliest Deposit, which is usually *later* than the
 * historical block — so at that block they held nothing, a zero capacity was simply correct, and
 * carrying the head balance backwards labelled that correct zero a documented protocol quirk.
 *
 * Both defects were seeded into `vault_capability.capabilities`, where they would make policy rules
 * report UNKNOWN on evidence that actually exists.
 *
 * This corrects them in place. It is deliberately *not* a re-verification:
 *
 *   - the same two blocks are probed, so each answer replaces the answer to the same question;
 *   - `deploymentBlock`, `windowStartBlock`, `codeHash` and the flow references are untouched;
 *   - the owner used for the capacity probes is recovered from the Deposit transaction the manifest
 *     already records, so it is the same account the gate used rather than a fresh choice.
 *
 * It runs through `@tr4ce/chain`, which is the point: that package claims to be the runtime twin of
 * the shell gate, and regenerating the gate's own output with it is the strongest available check
 * that the claim holds.
 *
 *   RPC_URL_BASE=<keyed endpoint> node scripts/reprobe-manifest.mjs [--write]
 *
 * Without `--write` it prints the diff and changes nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeEventLog, parseAbi } from "viem";

import { classifyCapabilities, createChainClient, readVaultAt } from "../dist/index.js";

const rpcUrl = process.env.RPC_URL_BASE;

if (!rpcUrl) {
  console.error("RPC_URL_BASE is required, and must be a keyed endpoint.");
  console.error("A public endpoint throttles these calls, which is what produced the bad data.");
  process.exit(1);
}

const write = process.argv.includes("--write");
const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test-vaults",
  "src",
  "manifest.json",
);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const client = createChainClient(rpcUrl);

const depositAbi = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
]);

/** The account the original gate probed capacity against, recovered from its recorded Deposit. */
async function recoverProbeOwner(vault) {
  const receipt = await client.getTransactionReceipt({
    hash: vault.evidence.earliestFlowTransactionHash,
  });

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault.address.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({ abi: depositAbi, data: log.data, topics: log.topics });

      if (decoded.eventName === "Deposit") {
        return decoded.args.owner;
      }
    } catch {
      // Not a Deposit log; keep looking.
    }
  }

  return null;
}

let changed = 0;

for (const vault of manifest.vaults) {
  const oneShareUnits = 10n ** BigInt(vault.shareDecimals);
  const owner = await recoverProbeOwner(vault);

  if (owner === null) {
    console.error(`${vault.symbol}: could not recover the probe owner; leaving its evidence alone.`);
    continue;
  }

  for (const [key, blockField] of [
    ["historicalProbes", "atBlock"],
    ["latestProbes", "atBlock"],
  ]) {
    const previous = vault.evidence[key];
    const block = BigInt(previous[0][blockField]);

    const results = await readVaultAt(client, {
      vault: vault.address,
      blockNumber: block,
      oneShareUnits,
      owner,
    });

    // Read at the block being probed, which is the fix for the second defect above.
    const holds = results.ownerShares?.ok === true && results.ownerShares.value > 0n;

    const fresh = classifyCapabilities({
      results,
      atBlock: block.toString(),
      ownerHoldsShares: holds,
    });

    // Keep the gate's method order so the diff shows only what actually changed.
    const ordered = previous
      .map((old) => fresh.find((probe) => probe.method === old.method) ?? old)
      .concat(fresh.filter((probe) => !previous.some((old) => old.method === probe.method)));

    for (const old of previous) {
      const now = ordered.find((probe) => probe.method === old.method);

      if (now && now.status !== old.status) {
        console.log(
          `${vault.symbol.padEnd(12)} ${key.padEnd(16)} ${old.method.padEnd(16)} ${old.status} -> ${now.status}`,
        );
        changed += 1;
      }
    }

    vault.evidence[key] = ordered;
  }

  vault.evidence.verifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  vault.evidence.rpcProviderKey = "base-alchemy-mainnet";
}

console.log(`\n${changed} probe status corrections.`);

if (write) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);
} else {
  console.log("Dry run. Pass --write to apply.");
}
