import type { CapabilityMethod, CapabilityProbe, CapabilityStatus } from "@tr4ce/domain";

/**
 * Reading a capability profile.
 *
 * The manifest records onboarding as arrays of probes — one per method, per block, with the raw
 * return data preserved. What a calculation needs is the status of one method. That reduction
 * happens here, once, so the rule that a non-standard zero is never read as a verified zero is
 * enforced in a single place rather than re-derived at each call site.
 *
 * Deviation from ARCHITECTURE.md section 7: that document describes
 * `CapabilityStatus = "supported" | "nonstandard" | "reverts" | "unknown"` and a flat
 * `{ maxWithdraw: CapabilityStatus, ... }` record. Neither shipped. The real contract is
 * `capabilityStatusSchema` in @tr4ce/domain (five members) over probe arrays, already written into
 * `manifest.json` for four verified vaults and the `vault_capability.capabilities` column. The
 * manifest is the event-period artifact; the document is stale.
 */

/** How a capability status is allowed to affect a policy decision. */
export type CapabilityUsability =
  /** The contract answered and the value can be used. */
  | "usable"
  /** The contract gave no usable answer. The dependent rule becomes UNKNOWN, never FAIL. */
  | "unknown";

/**
 * Whether a probe result may back a claim.
 *
 * `nonstandard_zero` is the case this mapping exists for. Morpho Vault V2 documents `maxWithdraw`
 * returning zero for an owner who demonstrably holds shares; reading that as "zero withdrawable"
 * would turn a documented quirk into a false liquidity claim, and a policy would FAIL a vault that
 * is fine. It resolves to `unknown` so the rule reports that it could not tell.
 */
export function usability(status: CapabilityStatus): CapabilityUsability {
  switch (status) {
    case "supported":
      return "usable";
    case "reverted":
    case "nonstandard_zero":
    case "ambiguous":
    case "unsupported":
      return "unknown";
  }
}

/**
 * The probe for one method at the block set the caller passes in.
 *
 * Returns null when the method was never probed — which is itself unknown, not supported.
 */
export function findProbe(
  probes: readonly CapabilityProbe[],
  method: CapabilityMethod,
): CapabilityProbe | null {
  return probes.find((probe) => probe.method === method) ?? null;
}

/** Status of one method, defaulting to `unsupported` when it was never probed at all. */
export function statusOf(
  probes: readonly CapabilityProbe[],
  method: CapabilityMethod,
): CapabilityStatus {
  return findProbe(probes, method)?.status ?? "unsupported";
}

/** Convenience for the common question: may this method's value back a claim? */
export function isUsable(
  probes: readonly CapabilityProbe[],
  method: CapabilityMethod,
): boolean {
  return usability(statusOf(probes, method)) === "usable";
}
