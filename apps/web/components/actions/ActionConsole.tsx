"use client";

import type { ActionStatusResponse, PreparedActionV1 } from "@tr4ce/domain";
import { useEffect, useState } from "react";
import { useAccount, useChainId, useSendTransaction } from "wagmi";

import { DataStateBanner } from "../ui/DataStateBanner";
import { WalletBar } from "../wallet/WalletBar";
import { recallAction } from "../../src/wallet/action-store";
import {
  awaitingReceipt,
  bannerState,
  canResimulate,
  explain,
  signingGate,
  steps,
  type WalletPhase,
} from "./action-state";
import styles from "./ActionConsole.module.css";

/**
 * One prepared action, from preparation to a settled receipt.
 *
 * TR4CE never submits (PRD TR-F-043). The wallet signs and broadcasts; this page hands the
 * resulting hash back to the API, which looks once for the receipt. Everything the console claims
 * about where the action stands comes from that API response — the only state kept locally is
 * whether the user is currently in front of their wallet.
 */

type ActionConsoleProps = { actionId: string; initialStatus: ActionStatusResponse };

export function ActionConsole({ actionId, initialStatus }: ActionConsoleProps) {
  const [status, setStatus] = useState(initialStatus);
  const [action, setAction] = useState<PreparedActionV1 | null>(null);
  const [phase, setPhase] = useState<WalletPhase>("idle");
  const [busy, setBusy] = useState<null | "simulate" | "receipt">(null);
  const [failure, setFailure] = useState<string | null>(null);

  const { address } = useAccount();
  const chainId = useChainId();
  const { sendTransactionAsync } = useSendTransaction();

  /*
   * The calldata is read after mount, not during render: `sessionStorage` does not exist on the
   * server, and reading it while rendering would make the first client render disagree with the
   * server's HTML.
   */
  useEffect(() => {
    setAction(recallAction(actionId));
  }, [actionId]);

  const wallet = { address: address ?? null, chainId: address === undefined ? null : chainId };
  const gate = action === null ? null : signingGate(action, status, wallet, phase);

  async function refresh(path: string, body?: unknown): Promise<void> {
    const response = await fetch(`/api/actions/${actionId}${path}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json();

    if (!response.ok) {
      setFailure(messageOf(payload));

      return;
    }

    setStatus(payload as ActionStatusResponse);
  }

  async function resimulate(): Promise<void> {
    setBusy("simulate");
    setFailure(null);

    try {
      await refresh("/simulate");
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Ask the wallet to sign the next call, then report what it produced.
   *
   * The order matters and is not an implementation detail: the hash is reported only after the
   * wallet has returned one. A rejection leaves the API's record untouched, because nothing
   * happened on any chain for it to record.
   */
  async function signNextCall(): Promise<void> {
    if (action === null || gate === null || !gate.can) {
      return;
    }

    const call = action.transactions[gate.callIndex];

    if (call === undefined) {
      return;
    }

    setPhase("awaiting-signature");
    setFailure(null);

    let hash: `0x${string}`;

    try {
      hash = await sendTransactionAsync({
        to: call.to as `0x${string}`,
        data: call.data as `0x${string}`,
        value: BigInt(call.value),
        // Passed explicitly so wagmi refuses a wrong-network send at the library level, rather than
        // relying on the wallet to notice. The gate above checks the same thing for the user's sake.
        chainId: call.chainId,
      });
    } catch (error) {
      setPhase("rejected");
      setFailure(describe(error));

      return;
    }

    setPhase("idle");

    try {
      await refresh("/submitted", {
        chainId: call.chainId,
        callIndex: gate.callIndex,
        transactionHash: hash,
      });
    } catch (error) {
      setFailure(describe(error));
    }
  }

  /**
   * Ask the API to look for the receipt again.
   *
   * Re-reporting the same hash, not polling the status route. `GET /v1/actions/:id` never looks at
   * a receipt; `POST /v1/actions/:id/submitted` looks exactly once, so a hash reported before it
   * was mined is checked again by reporting it again.
   */
  async function checkReceipt(): Promise<void> {
    const outcome = status.outcome;

    if (outcome === null) {
      return;
    }

    setBusy("receipt");
    setFailure(null);

    try {
      await refresh("/submitted", {
        chainId,
        // The operation call, which is the only one that carries an outcome: an ERC-20 approval
        // emits no ERC-4626 event, so there is nothing for a receipt to report about it.
        callIndex: status.callCount - 1,
        transactionHash: outcome.transactionHash,
      });
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.console}>
      <DataStateBanner state={bannerState(status)} detail={status.signable ? null : explain(status.reason)} />
      <div className={styles.body}>
        <header className={styles.head}>
          <h1 className={`display ${styles.title}`}>
            Review the exact call <em className="serifAccent">before wallet approval.</em>
          </h1>
          <p className="lede">
            TR4CE prepares and simulates. Your wallet signs and broadcasts, and the hash it returns is
            the only thing reported back.
          </p>
        </header>

        <WalletBar expectedOwner={action?.owner ?? null} />

        <ol aria-label="Action progress" className={styles.steps}>
          {steps(status).map((step, index) => (
            <li className={step.done ? styles.stepDone : styles.step} key={step.label}>
              <span className={styles.stepIndex}>{`0${index + 1}`}</span>
              {step.label}
            </li>
          ))}
        </ol>

        <p aria-live="polite" className={`${styles.statusLine} ${toneFor(status)}`}>
          <span className={styles.statusDot} aria-hidden="true" />
          {status.status}
          {status.signable ? "" : ` · ${explain(status.reason)}`}
        </p>

        {failure === null ? null : (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        )}

        <section className={styles.grid}>
          {action === null ? (
            /*
             * A cold load. The status came from the API, but the calldata did not — it only ever
             * comes back from `POST /v1/actions/prepare`, and this tab did not make that call.
             *
             * Said plainly rather than hidden behind an empty panel: the user can still see where
             * their action stands, and needs to know why they cannot sign from here.
             */
            <article className={`cardPanel ${styles.panel}`}>
              <p className="monoLabel">Calldata</p>
              <strong className={styles.panelTitle}>Not available in this tab</strong>
              <p>
                The transactions are returned once, when the action is prepared, and are kept only
                for the tab that prepared them. <code>GET /v1/actions/:id</code> answers with status
                alone, so a reload or a shared link can show progress but not the bytes to sign.
              </p>
              <p>
                Preparing this action again from the report would create a second action rather than
                recovering this one.
              </p>
            </article>
          ) : (
            <>
              <article className={`cardPanel ${styles.panel}`}>
                <p className="monoLabel">Operation</p>
                <strong className={styles.panelTitle}>{action.operation}</strong>
                <dl className={styles.list}>
                  <div><dt>Network</dt><dd>Base · chain {action.transactions[0]!.chainId}</dd></div>
                  <div><dt>Vault</dt><dd><code className={styles.hash}>{action.vault}</code></dd></div>
                  <div><dt>Asset</dt><dd><code className={styles.hash}>{action.asset}</code></dd></div>
                  <div>
                    <dt>Amount</dt>
                    <dd className="num">{action.amount} <small className={styles.sub}>base units</small></dd>
                  </div>
                  <div><dt>Owner</dt><dd><code className={styles.hash}>{action.owner}</code></dd></div>
                  <div><dt>Receiver</dt><dd><code className={styles.hash}>{action.receiver}</code></dd></div>
                  {/*
                    Labelled "previewed", not "you will receive". The vault's preview is what it
                    expects at this block; the actual figure comes from the event afterwards and is
                    never replaced by this one.
                  */}
                  <div>
                    <dt>Previewed {action.operation === "deposit" ? "shares" : "assets"}</dt>
                    <dd className="num">{action.previewed} <small className={styles.sub}>base units</small></dd>
                  </div>
                </dl>
              </article>

              <article className={`cardPanel ${styles.panel}`}>
                <p className="monoLabel">Simulation</p>
                <dl className={styles.list}>
                  <div><dt>Bound block</dt><dd className="num">{action.simulation.blockNumber}</dd></div>
                  <div>
                    <dt>Expiry</dt>
                    <dd>{new Date(status.expiresAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</dd>
                  </div>
                  <div><dt>Gas estimate</dt><dd className="num">{action.simulation.gasEstimate ?? "Unavailable"}</dd></div>
                  <div>
                    <dt>Calldata effect</dt>
                    {/* Read off the calls rather than asserted: a deposit is one call when the
                        allowance already covers the amount. */}
                    <dd>{action.transactions.map((transaction) => transaction.kind).join(" then ")}</dd>
                  </div>
                </dl>
                <div className={styles.calldata}>
                  <p className="monoLabel">
                    Unsigned calldata · {action.transactions.length} transaction
                    {action.transactions.length === 1 ? "" : "s"}
                  </p>
                  {/*
                    Every call is shown, in signing order. A deposit is two transactions when the
                    owner's allowance falls short of the amount and one when it does not, so hiding
                    any of them would hide the approval in exactly the case a user needs to see it.
                  */}
                  {action.transactions.map((transaction, index) => (
                    <div
                      className={index === status.nextCallIndex ? styles.callNext : styles.call}
                      data-call-index={index}
                      key={`${index}-${transaction.data}`}
                    >
                      <p className="monoLabel">
                        {index + 1}. {transaction.kind} · to {transaction.to}
                        {index < status.sentCount ? " · reported" : ""}
                        {index === status.nextCallIndex ? " · next" : ""}
                      </p>
                      <code data-testid={`calldata-${index}`}>{transaction.data}</code>
                    </div>
                  ))}
                </div>
              </article>
            </>
          )}
        </section>

        {status.outcome === null ? null : <Outcome outcome={status.outcome} />}

        <section aria-label="Wallet controls" className={`cardPanel ${styles.controls}`}>
          <p className="monoLabel">Sign and report</p>
          <div className={styles.controlsRow}>
            <button
              className="pill pillGreen pillSmall"
              disabled={gate === null || !gate.can}
              onClick={signNextCall}
              type="button"
            >
              {phase === "awaiting-signature"
                ? "Waiting for the wallet…"
                : gate !== null && gate.can
                  ? `Sign call ${gate.callIndex + 1} of ${status.callCount}`
                  : "Sign next call"}
            </button>
            <button
              className="pill pillGhost pillSmall"
              disabled={busy !== null || !canResimulate(status)}
              onClick={resimulate}
              type="button"
            >
              {busy === "simulate" ? "Simulating…" : "Resimulate"}
            </button>
            {!awaitingReceipt(status) ? null : (
              <button
                className="pill pillGhost pillSmall"
                disabled={busy !== null}
                onClick={checkReceipt}
                type="button"
              >
                {busy === "receipt" ? "Checking…" : "Check for the receipt"}
              </button>
            )}
          </div>
          {gate === null || gate.can ? null : (
            <p className={styles.gateReason} role="status">
              {gate.reason}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * What the chain did, beside what was previewed.
 *
 * `actual` is never filled in from `previewed`. A null says the vault's event was not observed,
 * which is a different claim from "the two agreed" — and only one of them would be true.
 */
function Outcome({ outcome }: { outcome: NonNullable<ActionStatusResponse["outcome"]> }) {
  return (
    <article className={`cardPanel ${styles.panel}`}>
      <p className="monoLabel">Outcome</p>
      <dl className={styles.list}>
        <div>
          <dt>Transaction</dt>
          <dd><code className={styles.hash}>{outcome.transactionHash}</code></dd>
        </div>
        <div>
          <dt>Receipt</dt>
          <dd>{outcome.status ?? "Not observed yet"}</dd>
        </div>
        <div>
          <dt>Confirmed in block</dt>
          <dd className="num">{outcome.confirmedBlockNumber ?? "Not observed yet"}</dd>
        </div>
        <div>
          <dt>Previewed</dt>
          <dd className="num">{outcome.previewed}</dd>
        </div>
        <div>
          <dt>Actual</dt>
          <dd className="num">{outcome.actual ?? "Not observed"}</dd>
        </div>
        <div>
          <dt>Difference</dt>
          <dd className="num">{outcome.delta ?? "Not observed"}</dd>
        </div>
      </dl>
    </article>
  );
}

function toneFor(status: ActionStatusResponse): string {
  if (status.status === "confirmed") return styles["toneGood"] ?? "";
  if (status.status === "reverted") return styles["toneBad"] ?? "";
  if (status.status === "submitted") return styles["toneInfo"] ?? "";
  if (!status.signable) return styles["toneWarn"] ?? "";

  return styles["toneNeutral"] ?? "";
}

function messageOf(body: unknown): string {
  const error = (body as { error?: { message?: unknown } } | null)?.error?.message;

  return typeof error === "string" ? error : "The request could not be completed.";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
