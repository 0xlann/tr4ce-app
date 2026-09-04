import { describe, expect, it } from "vitest";

import { advancePrototypeFlow, initialPrototypeState } from "./prototype-flow.js";

describe("advancePrototypeFlow", () => {
  it("moves a selected vault through report, prepared, simulated, and wallet-ready states", () => {
    const report = advancePrototypeFlow(initialPrototypeState, { type: "OPEN_REPORT", vaultId: "cedar" });
    const prepared = advancePrototypeFlow(report, { type: "PREPARE_DEPOSIT" });
    const simulated = advancePrototypeFlow(prepared, { type: "SIMULATE_SUCCESS" });
    const walletReady = advancePrototypeFlow(simulated, { type: "REQUEST_WALLET" });

    expect(report.screen).toBe("report");
    expect(prepared.actionStatus).toBe("prepared");
    expect(simulated.actionStatus).toBe("simulated");
    expect(walletReady.actionStatus).toBe("wallet-ready");
  });

  it("keeps simulated actions invalid when the wallet context changes", () => {
    const simulated = advancePrototypeFlow(
      advancePrototypeFlow(initialPrototypeState, { type: "PREPARE_DEPOSIT" }),
      { type: "SIMULATE_SUCCESS" },
    );

    expect(advancePrototypeFlow(simulated, { type: "WALLET_CONTEXT_CHANGED" }).actionStatus).toBe("invalidated");
  });
});
