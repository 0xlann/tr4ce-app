import { preparedActionV1Schema, type PreparedActionV1 } from "@tr4ce/domain";

/**
 * The prepared calls, for as long as this tab is open.
 *
 * `POST /v1/actions/prepare` is the only response in the contract that carries calldata;
 * `GET /v1/actions/:id` answers with status alone. So the browser that prepared an action is the
 * only place its transactions exist, and a cold load of `/actions/:id` — a reload, or a shared link
 * — can show where the action stands but not the bytes to sign. The console says so plainly rather
 * than rendering an empty panel.
 *
 * Two things this deliberately is not:
 *
 * It is not `localStorage`. Calldata carries an owner address and an amount, and there is no reason
 * for either to outlive the tab.
 *
 * It is not a cache to be repaired by re-preparing. `prepared_action_live_binding_key` is unique
 * over the calldata hash only `WHERE status IN ('prepared','simulated')`, so once a hash has been
 * reported the partial index no longer covers the row and preparing again inserts a second action
 * rather than naming the first.
 */

const PREFIX = "tr4ce.action.";

export function rememberAction(action: PreparedActionV1, storage: Storage | null = safeStorage()): void {
  if (storage === null) {
    return;
  }

  try {
    storage.setItem(`${PREFIX}${action.actionId}`, JSON.stringify(action));
  } catch {
    // Full, or blocked by the browser's privacy settings. The flow still works for the rest of this
    // page load; only a reload loses the calldata, which is already the documented behaviour.
  }
}

/**
 * The stored action, or null.
 *
 * Parsed through the same schema the API validated it out through. A stored value that no longer
 * satisfies the contract is treated as absent rather than rendered as though it did — this is
 * calldata a user is about to approve, and a half-recognised shape is not something to guess at.
 */
export function recallAction(
  actionId: string,
  storage: Storage | null = safeStorage(),
): PreparedActionV1 | null {
  if (storage === null) {
    return null;
  }

  let raw: string | null;

  try {
    raw = storage.getItem(`${PREFIX}${actionId}`);
  } catch {
    return null;
  }

  if (raw === null) {
    return null;
  }

  const parsed = preparedActionV1Schema.safeParse(parse(raw));

  return parsed.success && parsed.data.actionId === actionId ? parsed.data : null;
}

export function forgetAction(actionId: string, storage: Storage | null = safeStorage()): void {
  try {
    storage?.removeItem(`${PREFIX}${actionId}`);
  } catch {
    // Nothing to do, and nothing that depends on it.
  }
}

/** Accessing `sessionStorage` itself throws in some privacy modes, so even the lookup is guarded. */
function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
