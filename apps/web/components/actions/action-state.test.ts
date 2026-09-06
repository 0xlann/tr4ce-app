import { describe, expect, it } from "vitest";

import { initialActionState, reduceActionState } from "./action-state.js";

describe("action state", () => {
  it("invalidates a simulated action after wallet context changes", () => {
    const simulated = reduceActionState(initialActionState, { type: "SIMULATION_SUCCEEDED" });

    expect(reduceActionState(simulated, { type: "CONTEXT_CHANGED" }).status).toBe("invalidated");
  });

  it("preserves a wallet rejection as a distinct state", () => {
    expect(reduceActionState(initialActionState, { type: "WALLET_REJECTED" }).status).toBe("wallet-rejected");
  });
});
