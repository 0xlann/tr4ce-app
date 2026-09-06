"use client";

import type { ProvenanceEntry } from "@tr4ce/domain";
import { useRef } from "react";

import styles from "./ProvenanceChip.module.css";

type ProvenanceChipProps = { entries: readonly ProvenanceEntry[] };

export function ProvenanceChip({ entries }: ProvenanceChipProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const first = entries[0];

  if (!first) return null;

  function closeDrawer() {
    dialogRef.current?.close();
    triggerRef.current?.focus();
  }

  return (
    <>
      <button ref={triggerRef} className={styles.chip} onClick={() => dialogRef.current?.showModal()} type="button">
        <span aria-hidden="true">●</span>{first.chainId === 8453 ? "Base" : `Chain ${first.chainId}`} · block {first.blockNumber}
      </button>
      <dialog ref={dialogRef} aria-label="Evidence provenance" className={styles.drawer} onCancel={closeDrawer} onClose={() => triggerRef.current?.focus()}>
        <div className={styles.drawerHeader}><div><p>PROVENANCE</p><h2>Every claim has a block.</h2></div><button onClick={closeDrawer} type="button">Close</button></div>
        <div className={styles.entries}>{entries.map((entry) => <article key={`${entry.reference}-${entry.blockNumber}`}><p>{entry.sourceType}</p><strong>{entry.reference}</strong><code>Block {entry.blockNumber}</code><code>{entry.blockHash}</code></article>)}</div>
      </dialog>
    </>
  );
}
