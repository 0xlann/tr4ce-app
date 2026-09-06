"use client";

import type { PreparedActionV1 } from "@tr4ce/domain";
import { useReducer } from "react";

import { DataStateBanner } from "../ui/DataStateBanner";
import styles from "./ActionConsole.module.css";
import { initialActionState, reduceActionState } from "./action-state";

type ActionConsoleProps = { action: PreparedActionV1 };

const labels = ["Prepared", "Simulated", "Wallet confirmed"];

export function ActionConsole({ action }: ActionConsoleProps) {
  const [state, dispatch] = useReducer(reduceActionState, initialActionState);
  const canConfirm = state.status === "simulated";
  const canSubmit = state.status === "wallet-ready";
  const stateText = state.status.replaceAll("-", " ");

  return (
    <div className={styles.console}>
      <DataStateBanner state={state.status === "invalidated" ? "stale" : "fresh"} />
      <div className={styles.body}>
        <p className={styles.eyebrow}>PREPARED ACTION · ILLUSTRATIVE ONLY</p>
        <h1>Review the exact call before wallet approval.</h1>
        <p className={styles.lead}>The shown transaction is unsigned. These controls demonstrate state transitions only and do not contact a wallet.</p>
        <ol className={styles.steps}>
          {labels.map((label, index) => {
            const complete = index === 0
              || (index === 1 && ["simulated", "wallet-ready", "pending", "confirmed"].includes(state.status))
              || (index === 2 && ["wallet-ready", "pending", "confirmed"].includes(state.status));

            return <li className={complete ? styles.done : undefined} key={label}><span>0{index + 1}</span>{label}</li>;
          })}
        </ol>
        <section className={styles.grid}>
          <article>
            <p>OPERATION</p>
            <strong>{action.operation}</strong>
            <dl>
              <div><dt>Network</dt><dd>Base · chain {action.unsignedTransaction.chainId}</dd></div>
              <div><dt>Vault</dt><dd><code>{action.vault}</code></dd></div>
              <div><dt>Asset</dt><dd><code>{action.asset}</code></dd></div>
              <div><dt>Amount</dt><dd>10,000 USDC <small>{action.amount} base units</small></dd></div>
              <div><dt>Owner / receiver</dt><dd><code>{action.owner}</code></dd></div>
            </dl>
          </article>
          <article>
            <p>SIMULATION</p>
            <strong className={styles.state}>{stateText}</strong>
            <dl>
              <div><dt>Bound block</dt><dd>{action.simulation.blockNumber}</dd></div>
              <div><dt>Expiry</dt><dd>{new Date(action.simulation.expiresAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</dd></div>
              <div><dt>Gas estimate</dt><dd>{action.simulation.gasEstimate ?? "Unavailable"}</dd></div>
              <div><dt>Calldata effect</dt><dd>Exact approval then direct deposit</dd></div>
            </dl>
            <div className={styles.controls}>
              <button onClick={() => dispatch({ type: "SIMULATION_SUCCEEDED" })} type="button">Run simulation</button>
              <button onClick={() => dispatch({ type: "SIMULATION_FAILED" })} type="button">Show simulation failure</button>
              <button disabled={!canConfirm} onClick={() => dispatch({ type: "CONFIRM_WALLET" })} type="button">Confirm in wallet</button>
              <button disabled={!canSubmit} onClick={() => dispatch({ type: "SUBMITTED" })} type="button">Show submitted state</button>
              <button onClick={() => dispatch({ type: "CONTEXT_CHANGED" })} type="button">Change wallet context</button>
              <button onClick={() => dispatch({ type: "WALLET_REJECTED" })} type="button">Show wallet rejection</button>
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}
