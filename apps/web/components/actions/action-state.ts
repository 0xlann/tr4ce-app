import type { ActionStatusResponse, PreparedActionV1 } from "@tr4ce/domain";

/**
 * What the console may do, derived rather than remembered.
 *
 * There are two clocks here and only one of them is ours. The API owns where the action stands —
 * `prepared`, `simulated`, `submitted`, `confirmed`, `reverted`, `expired`, `invalidated` — and
 * judges it against the chain at the moment it is asked. The browser owns exactly one thing: whether
 * the user is currently in front of their wallet.
 *
 * Keeping those apart is the point of this module. A console that tracked the action's status in a
 * local reducer would eventually claim `confirmed` because the client thought so, which is the one
 * failure this product cannot have. So the reducer is gone and this is a pure function of the last
 * response plus the wallet's connection.
 */

/** The browser's own axis. Nothing here is ever reported to the API as a status. */
export type WalletPhase = "idle" | "awaiting-signature" | "rejected";

export type WalletContext = {
  /** The connected account, or null when no wallet is connected. */
  address: string | null;
  /** The chain the wallet is on, or null when not connected. */
  chainId: number | null;
};

export type SigningGate =
  | { can: true; callIndex: number }
  | { can: false; reason: string };

/**
 * Whether the next call may be put in front of the wallet.
 *
 * Evaluated on every render rather than in an effect keyed on account changes. An effect fires when
 * the account *changes*; it does not fire for someone who arrives already connected to the wrong
 * one, and that is the case a mismatch check exists for.
 *
 * The API's own `BINDING_CHANGED` is the backstop, not this. `actionDigest` covers the chain and the
 * account, so a wrong-account signature could never settle against this action — but discovering
 * that after the user has paid gas is not a useful place to discover it.
 */
export function signingGate(
  action: PreparedActionV1,
  status: ActionStatusResponse,
  wallet: WalletContext,
  phase: WalletPhase,
): SigningGate {
  if (phase === "awaiting-signature") {
    return { can: false, reason: "Waiting for the wallet to answer." };
  }

  if (wallet.address === null || wallet.chainId === null) {
    return { can: false, reason: "Connect the wallet that owns this action." };
  }

  // Case-insensitively: an address is the same address whether or not it is checksummed, and
  // refusing on capitalisation would be a mismatch the user cannot see or fix.
  if (wallet.address.toLowerCase() !== action.owner.toLowerCase()) {
    return {
      can: false,
      reason: `This action was prepared for ${action.owner}. The connected account is different, and the signature would not settle against it.`,
    };
  }

  if (status.nextCallIndex === null) {
    return { can: false, reason: "Every call has been reported." };
  }

  const call = action.transactions[status.nextCallIndex];

  if (call === undefined) {
    return { can: false, reason: "The API is expecting a call this action does not carry." };
  }

  if (wallet.chainId !== call.chainId) {
    return {
      can: false,
      reason: `This call is for chain ${call.chainId}. The wallet is on chain ${wallet.chainId}.`,
    };
  }

  if (!status.signable) {
    return { can: false, reason: explain(status.reason) };
  }

  return { can: true, callIndex: status.nextCallIndex };
}

/**
 * The five ways an action stops being signable, in words.
 *
 * Deliberately exhaustive over `signabilityReasonSchema` rather than falling through to a generic
 * message: each of these asks something different of the user, and only `NOT_SIMULATED` and the two
 * budgets are cleared by resimulating.
 */
export function explain(reason: string | null): string {
  switch (reason) {
    case "BINDING_CHANGED":
      return "Something the simulation was bound to has moved. Resimulate to check it against the current block.";
    case "BLOCK_BUDGET_SPENT":
      return "The simulation is too many blocks old to stand. Resimulate against the current block.";
    case "TIME_BUDGET_SPENT":
      return "The simulation has expired. Resimulate against the current block.";
    case "SIMULATION_FAILED":
      return "The chain refused this call in simulation. Signing it would spend gas on a revert.";
    case "NOT_SIMULATED":
      return "The next call has not been simulated yet. Its predecessor had to land first.";
    case null:
      return "This action is signable.";
    default:
      // Not smoothed away: an unrecognised reason is the contract having moved, and saying so is
      // more useful than presenting it as one of the five we do know.
      return `The API gave a reason this interface does not recognise: ${reason}.`;
  }
}

/**
 * Whether resimulating could change anything.
 *
 * A settled action is not resimulated — the call has already been made, and asking the chain to
 * imagine it again answers nothing. `SIMULATION_FAILED` is excluded for a different reason: the
 * chain refused, and asking again at the next block is the caller's decision to make explicitly.
 */
export function canResimulate(status: ActionStatusResponse): boolean {
  if (status.nextCallIndex === null) {
    return false;
  }

  return (
    status.status === "prepared" ||
    status.status === "simulated" ||
    status.status === "invalidated" ||
    status.status === "expired" ||
    status.status === "submitted"
  );
}

/**
 * Whether the action is waiting on a receipt that has not been observed.
 *
 * This is what makes re-reporting the hash worth offering. `GET /v1/actions/:id` never looks at a
 * receipt — only `POST /v1/actions/:id/submitted` does, and it looks exactly once. A hash reported
 * before it was mined leaves `outcome.status` null, and the way forward is to report the same hash
 * again rather than to poll the status route, which would sit on `submitted` for ever.
 */
export function awaitingReceipt(status: ActionStatusResponse): boolean {
  return status.status === "submitted" && status.outcome?.status !== "success";
}

/** The banner above the console. `stale` is the API's word for a binding that moved, not ours. */
export function bannerState(status: ActionStatusResponse): "fresh" | "stale" | "partial" {
  if (status.status === "invalidated" || status.status === "expired") {
    return "stale";
  }

  if (!status.signable && status.reason !== null && status.status !== "confirmed") {
    return status.reason === "SIMULATION_FAILED" ? "partial" : "stale";
  }

  return "fresh";
}

/**
 * How far along the action is, as three steps.
 *
 * Read off the API's own counters rather than a local step index: `sentCount` of `callCount` is the
 * only honest measure of how many calls have actually been reported, and a two-call deposit sits
 * halfway through this list for real rather than decoratively.
 */
export function steps(status: ActionStatusResponse): { label: string; done: boolean }[] {
  const settled = status.status === "confirmed" || status.status === "reverted";

  return [
    { label: "Prepared", done: true },
    {
      label: "Simulated",
      done: status.status !== "prepared" || status.attempts.some((attempt) => attempt.success),
    },
    {
      label:
        status.callCount === 1
          ? "Signed and reported"
          : `Signed and reported (${status.sentCount} of ${status.callCount})`,
      done: status.sentCount >= status.callCount,
    },
    { label: "Settled", done: settled },
  ];
}
