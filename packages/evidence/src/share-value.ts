import type { ReasonCode } from "@tr4ce/domain";

import { reduce, toBasisPoints, type BasisPointsResult } from "./rational.js";

/**
 * Observed share-value return — PRD section 3.
 *
 * For one whole share at block/time t, `P_t = convertToAssets(10^shareDecimals)`, and over a
 * lookback of d days, `r_d = P_t / P_(t-d) - 1`.
 *
 * This measures the historical change in the ERC-4626 conversion value. It is deliberately not
 * called "realized APY": it is not a user's realized profit, excludes user-specific fees and tax,
 * can be distorted by donations or vault-specific accounting, and predicts nothing. Those
 * limitations travel with every report that carries this number.
 */

/** Why a share-value return could not be produced. Never a substitute value. */
export type ShareValueFailure =
  | { kind: "missing_start"; reasonCode: ReasonCode }
  | { kind: "missing_end"; reasonCode: ReasonCode }
  | { kind: "unusable_start"; reasonCode: ReasonCode };

export type ShareValueResult =
  | { ok: true; return: BasisPointsResult }
  | { ok: false; failure: ShareValueFailure };

/**
 * Compute `endAssets / startAssets - 1` as a reduced rational plus floored basis points.
 *
 * Both inputs are the assets one whole share converts to, so the share decimals have already
 * cancelled and no decimal reconciliation happens here — that compatibility check belongs upstream,
 * where the two snapshots' capability profiles are compared.
 */
export function observedShareValueReturn(
  startAssets: bigint,
  endAssets: bigint,
): { numerator: bigint; denominator: bigint; bps: number } {
  if (startAssets === 0n) {
    throw new RangeError(
      "Start share value is zero; call observeShareValue for the checked, reason-coded path.",
    );
  }

  // (end - start) / start, kept as a ratio rather than a decimal so the report can show its work.
  const ratio = reduce(endAssets - startAssets, startAssets);
  const basisPoints = toBasisPoints(ratio);

  return {
    numerator: basisPoints.numerator,
    denominator: basisPoints.denominator,
    bps: basisPoints.value,
  };
}

/**
 * The checked entry point: nullable inputs in, a reason code out when no return exists.
 *
 * Snapshot amounts arrive from PostgreSQL as `string | null`, where `null` means the on-chain call
 * produced no usable value. Coercing that to `0n` anywhere on this path would turn "we do not
 * know" into "the share was worth nothing", which is the single most damaging thing this engine
 * could do — so the null cases are handled here, explicitly, and each carries a distinct reason.
 */
export function observeShareValue(
  startAssets: bigint | null,
  endAssets: bigint | null,
): ShareValueResult {
  if (endAssets === null) {
    return { ok: false, failure: { kind: "missing_end", reasonCode: "MISSING_OBSERVATION" } };
  }

  if (startAssets === null) {
    // No start observation at all: the window reaches further back than the indexed history.
    return { ok: false, failure: { kind: "missing_start", reasonCode: "MISSING_OBSERVATION" } };
  }

  if (startAssets === 0n) {
    /*
     * A start observation exists but reports a zero share value, which no solvent ERC-4626 vault
     * produces. Reported as AMBIGUOUS_CAPABILITY rather than MISSING_OBSERVATION so the report can
     * still distinguish "we have no start" from "we have a start we cannot trust" — the same
     * distinction the manifest already draws for a non-standard zero from maxWithdraw.
     */
    return { ok: false, failure: { kind: "unusable_start", reasonCode: "AMBIGUOUS_CAPABILITY" } };
  }

  const ratio = reduce(endAssets - startAssets, startAssets);

  return { ok: true, return: toBasisPoints(ratio) };
}
