import type { CapabilityMethod, CapabilityProbe, CapabilityStatus } from "@tr4ce/domain";

import type { ReadOutcome, VaultReadResults } from "./vault-reader.js";

/**
 * Interpretation, kept strictly downstream of the raw reads.
 *
 * This is the runtime twin of the ten-step onboarding gate in
 * `packages/test-vaults/scripts/verify-vault.sh`. It turns what the chain returned into the
 * capability vocabulary the rest of the system speaks, and it is the only place that judgement
 * happens.
 *
 * The rule it exists to enforce: an adapter may annotate known protocol behaviour, but it may never
 * turn a documented non-standard zero into a fabricated positive value, and it may never present a
 * zero it cannot explain as verified capacity (PRD section 8.3).
 */

/** Raw hex of a uint256 return value, so the probe records what came back, not just its meaning. */
function encodeUint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function encodeAddress(value: string): string {
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

export interface ClassifyOptions {
  results: VaultReadResults;
  /** Block the probes describe, as a decimal string. */
  atBlock: string;
  /**
   * Whether the probed owner demonstrably holds shares.
   *
   * The whole basis of the `nonstandard_zero` classification: a zero `maxWithdraw` for an owner
   * with no shares is simply correct, while the same zero for an owner who holds shares is a
   * documented protocol quirk that must not be read as "cannot withdraw".
   */
  ownerHoldsShares: boolean;
}

/**
 * Classify every read into a capability probe.
 *
 * The output feeds `packages/evidence`'s `usability()` reducer, which is where
 * `nonstandard_zero -> UNKNOWN, never FAIL` is applied. That mapping is not repeated here; this
 * module decides what happened, that one decides what it is allowed to support.
 */
export function classifyCapabilities(options: ClassifyOptions): CapabilityProbe[] {
  const { results, atBlock, ownerHoldsShares } = options;

  const probes: CapabilityProbe[] = [
    probeAddress("asset", results.asset, atBlock),
    probeNumeric("decimals", results.decimals, atBlock),
    probeNumeric("totalAssets", results.totalAssets, atBlock),
    probeNumeric("totalSupply", results.totalSupply, atBlock),
    probeNumeric("convertToAssets", results.convertToAssets, atBlock),
    probeNumeric("previewDeposit", results.previewDeposit, atBlock),
    probeNumeric("previewRedeem", results.previewRedeem, atBlock),
  ];

  // Account-scoped methods are only classified when they were actually attempted. A method that was
  // never called is not "unsupported"; it is simply absent from the profile.
  if (results.maxWithdraw !== null) {
    probes.push(probeCapacity("maxWithdraw", results.maxWithdraw, atBlock, ownerHoldsShares));
  }

  if (results.maxRedeem !== null) {
    probes.push(probeCapacity("maxRedeem", results.maxRedeem, atBlock, ownerHoldsShares));
  }

  return probes;
}

/** Did the owner hold shares at this block? Unknown reads answer "no", never a guessed "yes". */
export function ownerHoldsShares(results: VaultReadResults): boolean {
  return results.ownerShares !== null && results.ownerShares.ok && results.ownerShares.value > 0n;
}

function probeNumeric(
  method: CapabilityMethod,
  outcome: ReadOutcome,
  atBlock: string,
): CapabilityProbe {
  if (!outcome.ok) {
    return reverted(method, outcome, atBlock);
  }

  return {
    method,
    status: "supported" satisfies CapabilityStatus,
    atBlock,
    rawResult: encodeUint(outcome.value),
    revertData: null,
    reasonCode: null,
    note: null,
  } as CapabilityProbe;
}

function probeAddress(
  method: CapabilityMethod,
  outcome: { ok: true; value: string } | { ok: false; revertData: string | null; message: string },
  atBlock: string,
): CapabilityProbe {
  if (!outcome.ok) {
    return reverted(method, outcome, atBlock);
  }

  return {
    method,
    status: "supported" satisfies CapabilityStatus,
    atBlock,
    rawResult: encodeAddress(outcome.value),
    revertData: null,
    reasonCode: null,
    note: null,
  } as CapabilityProbe;
}

/**
 * Capacity methods, where a zero is the interesting case.
 *
 * A zero from an owner holding no shares is the correct answer. The same zero from an owner who
 * demonstrably holds shares is the documented non-standard behaviour: the raw result is preserved
 * and the capacity is left unresolved, rather than being reported as "nothing withdrawable".
 */
function probeCapacity(
  method: CapabilityMethod,
  outcome: ReadOutcome,
  atBlock: string,
  holdsShares: boolean,
): CapabilityProbe {
  if (!outcome.ok) {
    return reverted(method, outcome, atBlock);
  }

  if (outcome.value === 0n && holdsShares) {
    return {
      method,
      status: "nonstandard_zero" satisfies CapabilityStatus,
      atBlock,
      rawResult: encodeUint(0n),
      revertData: null,
      reasonCode: "AMBIGUOUS_CAPABILITY",
      note: "Returned zero for an owner holding shares; raw result preserved, capacity unresolved.",
    } as CapabilityProbe;
  }

  return probeNumeric(method, outcome, atBlock);
}

function reverted(
  method: CapabilityMethod,
  outcome: { revertData: string | null },
  atBlock: string,
): CapabilityProbe {
  return {
    method,
    status: "reverted" satisfies CapabilityStatus,
    atBlock,
    rawResult: null,
    revertData: outcome.revertData,
    reasonCode: "CALL_REVERTED",
    note: null,
  } as CapabilityProbe;
}
