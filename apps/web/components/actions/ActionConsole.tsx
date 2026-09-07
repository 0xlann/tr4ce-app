"use client";

import type { PreparedActionV1 } from "@tr4ce/domain";
import { useReducer } from "react";

import { DataStateBanner } from "../ui/DataStateBanner";
import styles from "./ActionConsole.module.css";
import { initialActionState, reduceActionState } from "./action-state";

type ActionConsoleProps = { action: PreparedActionV1 };

const labels = ["Prepared", "Simulated", "Wallet confirmed"];

const statusTone: Record<string, string | undefined> = {
  prepared: styles.toneNeutral,
  simulated: styles.toneGood,
  "simulation-failed": styles.toneBad,
  invalidated: styles.toneWarn,
  "wallet-ready": styles.toneGood,
  "wallet-rejected": styles.toneBad,
  pending: styles.toneInfo,
  confirmed: styles.toneGood,
  reverted: styles.toneBad,
  "receipt-reconciliation-failed": styles.toneBad,
};

export function ActionConsole({ action }: ActionConsoleProps) {
  const [state, dispatch] = useReducer(reduceActionState, initialActionState);
  const canConfirm = state.status === "simulated";
  const canSubmit = state.status === "wallet-ready";
  const stateText = state.status.replaceAll("-", " ");

  return (
    <div className={styles.console}>
      <DataStateBanner state={state.status === "invalidated" ? "stale" : "fresh"} />
      <div className={styles.body}>
        <header className={styles.head}>
          <h1 className={`display ${styles.title}`}>
            Review the exact call <em className="serifAccent">before wallet approval.</em>
          </h1>
          <p className="lede">
            The shown transaction is unsigned. These controls demonstrate state transitions only and
            do not contact a wallet.
          </p>
        </header>

        <ol aria-label="Action progress" className={styles.steps}>
          {labels.map((label, index) => {
            const complete = index === 0
              || (index === 1 && ["simulated", "wallet-ready", "pending", "confirmed"].includes(state.status))
              || (index === 2 && ["wallet-ready", "pending", "confirmed"].includes(state.status));

            return (
              <li className={complete ? styles.stepDone : styles.step} key={label}>
                <span className={styles.stepIndex}>{`0${index + 1}`}</span>
                {label}
              </li>
            );
          })}
        </ol>

        <p aria-live="polite" className={`${styles.statusLine} ${statusTone[state.status] ?? styles.toneNeutral}`}>
          <span className={styles.statusDot} aria-hidden="true" />
          {stateText}
        </p>

        <section className={styles.grid}>
          <article className={`cardPanel ${styles.panel}`}>
            <p className="monoLabel">Operation</p>
            <strong className={styles.panelTitle}>{action.operation}</strong>
            <dl className={styles.list}>
              <div><dt>Network</dt><dd>Base · chain {action.transactions[0]!.chainId}</dd></div>
              <div><dt>Vault</dt><dd><code className={styles.hash}>{action.vault}</code></dd></div>
              <div><dt>Asset</dt><dd><code className={styles.hash}>{action.asset}</code></dd></div>
              <div><dt>Amount</dt><dd>10,000 USDC <small className={styles.sub}>{action.amount} base units</small></dd></div>
              <div><dt>Owner / receiver</dt><dd><code className={styles.hash}>{action.owner}</code></dd></div>
            </dl>
          </article>

          <article className={`cardPanel ${styles.panel}`}>
            <p className="monoLabel">Simulation</p>
            <dl className={styles.list}>
              <div><dt>Bound block</dt><dd className="num">{action.simulation.blockNumber}</dd></div>
              <div><dt>Expiry</dt><dd>{new Date(action.simulation.expiresAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</dd></div>
              <div><dt>Gas estimate</dt><dd className="num">{action.simulation.gasEstimate ?? "Unavailable"}</dd></div>
              <div><dt>Calldata effect</dt><dd>Exact approval then direct deposit</dd></div>
            </dl>
            <div className={styles.calldata}>
              <p className="monoLabel">
                Unsigned calldata · {action.transactions.length} transaction
                {action.transactions.length === 1 ? "" : "s"}
              </p>
              {/*
                Every call is shown, in signing order. A deposit is two transactions when the
                owner's allowance falls short of the amount and one when it does not, so hiding any
                of them would hide the approval in exactly the case a user needs to see it.
              */}
              {action.transactions.map((transaction, index) => (
                <div className={styles.call} key={transaction.data}>
                  <p className="monoLabel">
                    {index + 1}. to {transaction.to}
                  </p>
                  <code>{transaction.data}</code>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section aria-label="State transition controls" className={`cardPanel ${styles.controls}`}>
          <p className="monoLabel">Walk the states</p>
          <div className={styles.controlsRow}>
            <button className="pill pillGreen pillSmall" onClick={() => dispatch({ type: "SIMULATION_SUCCEEDED" })} type="button">Run simulation</button>
            <button className="pill pillGhost pillSmall" onClick={() => dispatch({ type: "SIMULATION_FAILED" })} type="button">Show simulation failure</button>
            <button className="pill pillGhost pillSmall" disabled={!canConfirm} onClick={() => dispatch({ type: "CONFIRM_WALLET" })} type="button">Confirm in wallet</button>
            <button className="pill pillGhost pillSmall" disabled={!canSubmit} onClick={() => dispatch({ type: "SUBMITTED" })} type="button">Show submitted state</button>
            <button className="pill pillGhost pillSmall" onClick={() => dispatch({ type: "CONTEXT_CHANGED" })} type="button">Change wallet context</button>
            <button className="pill pillGhost pillSmall" onClick={() => dispatch({ type: "WALLET_REJECTED" })} type="button">Show wallet rejection</button>
          </div>
        </section>
      </div>
    </div>
  );
}
