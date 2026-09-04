export type PrototypeScreen = "compare" | "report" | "action";
export type ActionStatus = "idle" | "prepared" | "simulated" | "wallet-ready" | "simulation-failed" | "invalidated";

export type PrototypeState = {
  screen: PrototypeScreen;
  selectedVaultId: string;
  actionStatus: ActionStatus;
};

export type PrototypeEvent =
  | { type: "OPEN_COMPARE" }
  | { type: "OPEN_REPORT"; vaultId: string }
  | { type: "PREPARE_DEPOSIT" }
  | { type: "SIMULATE_SUCCESS" }
  | { type: "SIMULATE_FAILURE" }
  | { type: "REQUEST_WALLET" }
  | { type: "WALLET_CONTEXT_CHANGED" };

export const initialPrototypeState: PrototypeState = {
  screen: "compare",
  selectedVaultId: "cedar",
  actionStatus: "idle",
};

export function advancePrototypeFlow(state: PrototypeState, event: PrototypeEvent): PrototypeState {
  switch (event.type) {
    case "OPEN_COMPARE":
      return { ...state, screen: "compare" };
    case "OPEN_REPORT":
      return { ...state, screen: "report", selectedVaultId: event.vaultId, actionStatus: "idle" };
    case "PREPARE_DEPOSIT":
      return { ...state, screen: "action", actionStatus: "prepared" };
    case "SIMULATE_SUCCESS":
      return { ...state, actionStatus: "simulated" };
    case "SIMULATE_FAILURE":
      return { ...state, actionStatus: "simulation-failed" };
    case "REQUEST_WALLET":
      return { ...state, actionStatus: "wallet-ready" };
    case "WALLET_CONTEXT_CHANGED":
      return { ...state, actionStatus: "invalidated" };
  }
}
