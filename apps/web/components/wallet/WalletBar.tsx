"use client";

import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_ID } from "../../src/wallet/config";
import styles from "./WalletBar.module.css";

/**
 * Connect, and say plainly which account and chain are connected.
 *
 * The address is shown in full rather than truncated. Everywhere else a shortened address is a
 * convenience; here it is the thing a signature will be attributed to, and `0xAAaa…AAaa` hides
 * exactly the middle that distinguishes two accounts from the same wallet.
 */

type WalletBarProps = {
  /** The account the action was prepared for, when one is known. Null on a cold load. */
  expectedOwner: string | null;
};

export function WalletBar({ expectedOwner }: WalletBarProps) {
  const { address, status } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const connector = connectors[0];
  const mismatched =
    address !== undefined &&
    expectedOwner !== null &&
    address.toLowerCase() !== expectedOwner.toLowerCase();

  if (address === undefined) {
    return (
      <section aria-label="Wallet" className={`cardPanel ${styles.bar}`}>
        <div>
          <p className="monoLabel">Wallet</p>
          <p className={styles.value}>Not connected</p>
        </div>
        <button
          className="pill pillGreen pillSmall"
          disabled={connector === undefined || isPending || status === "connecting"}
          onClick={() => connector && connect({ connector })}
          type="button"
        >
          {connector === undefined
            ? "No wallet detected"
            : isPending
              ? "Connecting…"
              : "Connect wallet"}
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Wallet" className={`cardPanel ${styles.bar}`}>
      <div>
        <p className="monoLabel">Connected account</p>
        <p className={styles.value}>
          <code>{address}</code>
        </p>
        <p className={styles.chain}>
          {chainId === CHAIN_ID ? "Base" : `Chain ${chainId}`}
          {chainId === CHAIN_ID ? "" : " · not the chain this action is for"}
        </p>
        {!mismatched ? null : (
          // assertive, not polite: this blocks the only action on the page, and DESIGN-SYSTEMS
          // section 13 reserves `alert` for exactly that.
          <p className={styles.mismatch} role="alert">
            This action was prepared for a different account. Switch to {expectedOwner} to sign it.
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {chainId === CHAIN_ID ? null : (
          <button
            className="pill pillGhost pillSmall"
            onClick={() => switchChain({ chainId: CHAIN_ID })}
            type="button"
          >
            Switch to Base
          </button>
        )}
        <button className="pill pillGhost pillSmall" onClick={() => disconnect()} type="button">
          Disconnect
        </button>
      </div>
    </section>
  );
}
