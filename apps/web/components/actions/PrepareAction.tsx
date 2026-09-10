"use client";

import { preparedActionResponseSchema } from "@tr4ce/domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";

import { WalletBar } from "../wallet/WalletBar";
import { rememberAction } from "../../src/wallet/action-store";
import styles from "./PrepareAction.module.css";

/**
 * Turn a report into a prepared action.
 *
 * Preparation is not execution: this asks the API to build the exact calls and simulate them, and
 * returns unsigned calldata. Nothing is signed here and nothing is sent.
 *
 * The amount is in base units, which is what the contract takes and therefore what is shown. A
 * decimal field would mean this component owning a rounding rule, and a rounding rule in the
 * browser is a second opinion about an amount the chain will read exactly.
 */

type PrepareActionProps = {
  chainId: number;
  vaultAddress: string;
  reportId: string;
  assetSymbol: string | null;
};

export function PrepareAction({ chainId, vaultAddress, reportId, assetSymbol }: PrepareActionProps) {
  const router = useRouter();
  const { address } = useAccount();
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function prepare(): Promise<void> {
    if (address === undefined) {
      return;
    }

    setPending(true);
    setFailure(null);

    try {
      const response = await fetch("/api/actions/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId,
          vaultAddress,
          operation: "deposit",
          owner: address,
          receiver: address,
          amount: amount.trim(),
          reportId,
        }),
      });
      const body: unknown = await response.json();

      if (!response.ok) {
        setFailure(messageOf(body));

        return;
      }

      const { action } = preparedActionResponseSchema.parse(body);

      /*
       * Kept before navigating, not after. `GET /v1/actions/:id` carries no calldata, so this is the
       * only moment the transactions exist anywhere in the browser — losing them here would leave a
       * page that can show progress but never a signature.
       */
      rememberAction(action);
      router.push(`/actions/${action.actionId}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.prepare}>
      <WalletBar expectedOwner={null} />

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void prepare();
        }}
      >
        <div className={styles.field}>
          <label htmlFor="deposit-amount">Deposit amount</label>
          <input
            aria-describedby="deposit-amount-hint"
            className={styles.input}
            id="deposit-amount"
            inputMode="numeric"
            onChange={(event) => setAmount(event.target.value)}
            placeholder="10000000"
            spellCheck={false}
            value={amount}
          />
          <p className={styles.hint} id="deposit-amount-hint">
            {assetSymbol ?? "Asset"} base units. The approval, if one is needed, is for this exact
            amount and never for an unlimited allowance.
          </p>
        </div>

        <button
          className="pill pillGreen"
          disabled={pending || address === undefined || amount.trim().length === 0}
          type="submit"
        >
          {pending ? "Preparing…" : "Prepare action"}
        </button>
      </form>

      {failure === null ? null : (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}

      <p className={styles.note}>
        Preparation builds and simulates the calls. Signing happens in your wallet, on the next page.
      </p>
    </div>
  );
}

function messageOf(body: unknown): string {
  const error = (body as { error?: { message?: unknown } } | null)?.error?.message;

  return typeof error === "string" ? error : "The action could not be prepared.";
}
