import { actionOutcomeSchema, type ActionStatusResponse, type PreparedActionV1 } from "@tr4ce/domain";
import { describe, expect, it } from "vitest";

import {
  awaitingReceipt,
  bannerState,
  canResimulate,
  explain,
  signingGate,
  steps,
} from "./action-state";

/**
 * The wallet gate, tested where it lives.
 *
 * These are the checks standing between a user and a signature that cannot settle. Every one of
 * them is a pure function of the last API response plus the wallet's connection, which is the whole
 * reason this logic is not inside the component.
 */

const OWNER = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ASSET = "0xcccccccccccccccccccccccccccccccccccccccc";

function action(overrides: Partial<PreparedActionV1> = {}): PreparedActionV1 {
  return {
    schemaVersion: "1.0.0",
    actionId: "act_00000000000000000000000000000001",
    operation: "deposit",
    vault: VAULT,
    asset: ASSET,
    owner: OWNER,
    receiver: OWNER,
    amount: "1000000",
    transactions: [
      { chainId: 8453, to: ASSET, data: "0x095ea7b3", value: "0", kind: "approve" },
      { chainId: 8453, to: VAULT, data: "0x6e553f65", value: "0", kind: "deposit" },
    ],
    previewed: "999999",
    simulation: {
      status: "SUCCEEDED",
      blockNumber: "50879900",
      blockHash: `0x${"1".repeat(64)}`,
      expiresAt: "2026-09-10T12:00:00.000Z",
      gasEstimate: "120000",
      reasonCodes: [],
    },
    ...overrides,
  } as PreparedActionV1;
}

function status(overrides: Partial<ActionStatusResponse> = {}): ActionStatusResponse {
  return {
    schemaVersion: "1.0.0",
    actionId: "act_00000000000000000000000000000001",
    status: "simulated",
    signable: true,
    reason: null,
    expiresAt: "2026-09-10T12:00:00.000Z",
    callCount: 2,
    sentCount: 0,
    nextCallIndex: 0,
    outcome: null,
    attempts: [],
    ...overrides,
  } as ActionStatusResponse;
}

const connected = { address: OWNER, chainId: 8453 };

describe("signingGate", () => {
  it("allows the next call when the wallet matches and the API says signable", () => {
    expect(signingGate(action(), status(), connected, "idle")).toEqual({ can: true, callIndex: 0 });
  });

  it("refuses a different account rather than letting the signature fail later", () => {
    /*
     * `actionDigest` covers the account, so a signature from the wrong one could never settle
     * against this action. The server would catch it — after the user had already paid gas.
     */
    const gate = signingGate(
      action(),
      status(),
      { address: "0x9999999999999999999999999999999999999999", chainId: 8453 },
      "idle",
    );

    expect(gate.can).toBe(false);
    expect(gate.can === false && gate.reason).toContain(OWNER);
  });

  it("treats a checksummed address as the same address", () => {
    // Refusing on capitalisation would be a mismatch the user can neither see nor fix.
    const gate = signingGate(action(), status(), { address: OWNER.toLowerCase(), chainId: 8453 }, "idle");

    expect(gate).toEqual({ can: true, callIndex: 0 });
  });

  it("refuses when the wallet is on another chain", () => {
    const gate = signingGate(action(), status(), { address: OWNER, chainId: 1 }, "idle");

    expect(gate.can).toBe(false);
    expect(gate.can === false && gate.reason).toContain("chain 8453");
  });

  it("refuses while the wallet is being asked", () => {
    expect(signingGate(action(), status(), connected, "awaiting-signature").can).toBe(false);
  });

  it("refuses when no wallet is connected", () => {
    expect(signingGate(action(), status(), { address: null, chainId: null }, "idle").can).toBe(false);
  });

  it("carries the API's reason through when it says the action is not signable", () => {
    const gate = signingGate(
      action(),
      status({ signable: false, reason: "NOT_SIMULATED", sentCount: 1, nextCallIndex: 1 }),
      connected,
      "idle",
    );

    expect(gate.can).toBe(false);
    expect(gate.can === false && gate.reason).toContain("has not been simulated");
  });

  it("signs the second call once the first has been reported", () => {
    // The two-call deposit: after the approval's hash lands, index 1 is what the wallet is shown.
    const gate = signingGate(action(), status({ sentCount: 1, nextCallIndex: 1 }), connected, "idle");

    expect(gate).toEqual({ can: true, callIndex: 1 });
  });

  it("stops when every call has been reported", () => {
    const gate = signingGate(
      action(),
      status({ status: "submitted", sentCount: 2, nextCallIndex: null }),
      connected,
      "idle",
    );

    expect(gate.can).toBe(false);
  });

  it("refuses a call index the action does not carry", () => {
    // The contract could drift; renders of `transactions[7]` must not be attempted regardless.
    const gate = signingGate(action(), status({ nextCallIndex: 7 }), connected, "idle");

    expect(gate.can).toBe(false);
  });
});

describe("explain", () => {
  it("gives each signability reason its own words", () => {
    const reasons = [
      "BINDING_CHANGED",
      "BLOCK_BUDGET_SPENT",
      "TIME_BUDGET_SPENT",
      "SIMULATION_FAILED",
      "NOT_SIMULATED",
    ];
    const messages = reasons.map((reason) => explain(reason));

    expect(new Set(messages).size).toBe(reasons.length);
  });

  it("says so rather than guessing when the reason is unrecognised", () => {
    expect(explain("SOMETHING_NEW")).toContain("does not recognise");
  });
});

describe("canResimulate", () => {
  it("offers resimulation while calls remain", () => {
    expect(canResimulate(status({ status: "invalidated", signable: false, reason: "BINDING_CHANGED" }))).toBe(true);
  });

  it("does not offer it once the action has settled", () => {
    expect(canResimulate(status({ status: "confirmed", nextCallIndex: null }))).toBe(false);
    expect(canResimulate(status({ status: "reverted", nextCallIndex: null }))).toBe(false);
  });
});

describe("awaitingReceipt", () => {
  it("is true for a hash reported but not yet observed", () => {
    /*
     * The shape the API actually returns here, confirmed against it: once the operation call's hash
     * is reported the outcome exists, with `status` null until a receipt is found. That distinction
     * is the whole point — a reported hash is not an outcome.
     *
     * The mechanism is easy to get backwards: GET never looks at a receipt. Only reporting the same
     * hash again does, which is why this needs a name.
     */
    const reported = status({
      status: "submitted",
      sentCount: 2,
      nextCallIndex: null,
      outcome: actionOutcomeSchema.parse({
        transactionHash: `0x${"b".repeat(64)}`,
        status: null,
        confirmedBlockNumber: null,
        previewed: "999999",
        actual: null,
        delta: null,
      }),
    });

    expect(awaitingReceipt(reported)).toBe(true);
  });

  it("is false once the receipt says the transaction succeeded", () => {
    // Parsed rather than cast: the amount and hash fields are branded, and the schema is the only
    // thing that mints those brands — which also means this literal has to be a valid outcome.
    const settled = status({
      status: "submitted",
      outcome: actionOutcomeSchema.parse({
        transactionHash: `0x${"a".repeat(64)}`,
        status: "success",
        confirmedBlockNumber: "50879950",
        previewed: "999999",
        actual: "999998",
        delta: "-1",
      }),
    });

    expect(awaitingReceipt(settled)).toBe(false);
  });
});

describe("bannerState", () => {
  it("calls a moved binding stale and a refused simulation partial", () => {
    expect(bannerState(status({ signable: false, reason: "BINDING_CHANGED" }))).toBe("stale");
    expect(bannerState(status({ signable: false, reason: "SIMULATION_FAILED" }))).toBe("partial");
    expect(bannerState(status())).toBe("fresh");
  });
});

describe("steps", () => {
  it("counts the calls actually reported rather than a local step index", () => {
    const rendered = steps(status({ status: "submitted", sentCount: 1, nextCallIndex: 1 }));

    expect(rendered[2]?.label).toContain("1 of 2");
    expect(rendered[2]?.done).toBe(false);
    expect(rendered[3]?.done).toBe(false);
  });

  it("does not name a count when there is only one call", () => {
    const rendered = steps(status({ callCount: 1, sentCount: 1, nextCallIndex: null, status: "confirmed" }));

    expect(rendered[2]?.label).toBe("Signed and reported");
    expect(rendered[3]?.done).toBe(true);
  });
});
