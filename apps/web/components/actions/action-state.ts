export type ActionStatus =
  | "prepared"
  | "simulated"
  | "simulation-failed"
  | "invalidated"
  | "wallet-ready"
  | "wallet-rejected"
  | "pending"
  | "confirmed"
  | "reverted"
  | "receipt-reconciliation-failed";

export type ActionState = { status: ActionStatus };
export type ActionEvent =
  | { type: "SIMULATION_SUCCEEDED" }
  | { type: "SIMULATION_FAILED" }
  | { type: "CONTEXT_CHANGED" }
  | { type: "CONFIRM_WALLET" }
  | { type: "WALLET_REJECTED" }
  | { type: "SUBMITTED" }
  | { type: "CONFIRMED" }
  | { type: "REVERTED" }
  | { type: "RECONCILIATION_FAILED" }
  | { type: "RESET" };

export const initialActionState: ActionState = { status: "prepared" };

export function reduceActionState(state: ActionState, event: ActionEvent): ActionState {
  switch (event.type) {
    case "SIMULATION_SUCCEEDED":
      return { status: "simulated" };
    case "SIMULATION_FAILED":
      return { status: "simulation-failed" };
    case "CONTEXT_CHANGED":
      return { status: state.status === "simulated" || state.status === "wallet-ready" ? "invalidated" : state.status };
    case "CONFIRM_WALLET":
      return { status: state.status === "simulated" ? "wallet-ready" : state.status };
    case "WALLET_REJECTED":
      return { status: "wallet-rejected" };
    case "SUBMITTED":
      return { status: state.status === "wallet-ready" ? "pending" : state.status };
    case "CONFIRMED":
      return { status: "confirmed" };
    case "REVERTED":
      return { status: "reverted" };
    case "RECONCILIATION_FAILED":
      return { status: "receipt-reconciliation-failed" };
    case "RESET":
      return initialActionState;
  }
}
