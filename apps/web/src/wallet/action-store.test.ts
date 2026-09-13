import { preparedActionV1Schema, type PreparedActionV1 } from "@tr4ce/domain";
import { describe, expect, it } from "vitest";

import { forgetAction, recallAction, rememberAction } from "./action-store";
import { walletMode } from "./config";

/**
 * The calldata a user is about to approve, coming back out of storage.
 *
 * The bar is higher here than for a cached preference: whatever `recallAction` returns is rendered
 * as the exact bytes a wallet will be asked to sign. A shape that is only half recognised has to
 * come back as nothing at all.
 */

const ACTION_ID = "act_0123456789abcdef0123456789abcdef";

const action: PreparedActionV1 = preparedActionV1Schema.parse({
  schemaVersion: "1.0.0",
  actionId: ACTION_ID,
  operation: "deposit",
  vault: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  asset: "0xcccccccccccccccccccccccccccccccccccccccc",
  owner: "0x1111111111111111111111111111111111111111",
  receiver: "0x1111111111111111111111111111111111111111",
  amount: "1000000",
  transactions: [
    {
      chainId: 8453,
      to: "0xcccccccccccccccccccccccccccccccccccccccc",
      data: "0x095ea7b3",
      value: "0",
      kind: "approve",
    },
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
});

/** A `Storage` that lives in the test, so nothing depends on a DOM being present. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();

  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("action-store", () => {
  it("returns the action it was given", () => {
    const storage = memoryStorage();

    rememberAction(action, storage);

    expect(recallAction(ACTION_ID, storage)).toEqual(action);
  });

  it("returns null for an action it never stored", () => {
    expect(recallAction("act_ffffffffffffffffffffffffffffffff", memoryStorage())).toBeNull();
  });

  it("refuses a stored value that no longer matches the contract", () => {
    /*
     * The case that matters. A truncated or half-migrated value must not be rendered as calldata:
     * showing `undefined` where a `to` address belongs would be an invitation to sign something
     * nobody can read.
     */
    const storage = memoryStorage();

    storage.setItem(`tr4ce.action.${ACTION_ID}`, JSON.stringify({ ...action, transactions: [] }));

    expect(recallAction(ACTION_ID, storage)).toBeNull();
  });

  it("refuses a value stored under someone else's id", () => {
    // Guards against a key collision handing back the wrong action's bytes.
    const storage = memoryStorage();

    storage.setItem("tr4ce.action.act_ffffffffffffffffffffffffffffffff", JSON.stringify(action));

    expect(recallAction("act_ffffffffffffffffffffffffffffffff", storage)).toBeNull();
  });

  it("refuses text that is not JSON at all", () => {
    const storage = memoryStorage();

    storage.setItem(`tr4ce.action.${ACTION_ID}`, "not json");

    expect(recallAction(ACTION_ID, storage)).toBeNull();
  });

  it("forgets on request", () => {
    const storage = memoryStorage();

    rememberAction(action, storage);
    forgetAction(ACTION_ID, storage);

    expect(recallAction(ACTION_ID, storage)).toBeNull();
  });

  it("does nothing, rather than throwing, when there is no storage", () => {
    // Private modes throw on the accessor itself. The flow still works for this page load.
    expect(() => rememberAction(action, null)).not.toThrow();
    expect(recallAction(ACTION_ID, null)).toBeNull();
  });
});

describe("walletMode", () => {
  it("only offers the mock connector when the flag says so exactly", () => {
    /*
     * The mock connector signs nothing and would let a visitor report hashes for transactions no
     * wallet ever saw. Anything other than the exact string has to fall back to a real wallet.
     */
    expect(walletMode({ NEXT_PUBLIC_TR4CE_WALLET_MODE: "mock" })).toBe("mock");
    expect(walletMode({ NEXT_PUBLIC_TR4CE_WALLET_MODE: "MOCK" })).toBe("injected");
    expect(walletMode({ NEXT_PUBLIC_TR4CE_WALLET_MODE: "true" })).toBe("injected");
    expect(walletMode({})).toBe("injected");
  });
});
