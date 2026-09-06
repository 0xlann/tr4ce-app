"use client";

import type { ProvenanceEntry } from "@tr4ce/domain";
import { useRef } from "react";

import styles from "./ProvenanceChip.module.css";

type ProvenanceChipProps = { entries: readonly ProvenanceEntry[] };

function LinkGlyph() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 16 16">
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M7.3 4.4 8.6 3a2.7 2.7 0 0 1 3.9 0 2.7 2.7 0 0 1 0 3.9l-1.4 1.4" />
      <path d="M8.7 11.6 7.4 13a2.7 2.7 0 0 1-3.9 0 2.7 2.7 0 0 1 0-3.9l1.4-1.4" />
    </svg>
  );
}

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
        <LinkGlyph />
        {first.chainId === 8453 ? "Base" : `Chain ${first.chainId}`} · block {first.blockNumber}
      </button>
      <dialog ref={dialogRef} aria-label="Evidence provenance" className={styles.drawer} onCancel={closeDrawer} onClose={() => triggerRef.current?.focus()}>
        <div className={styles.drawerHeader}>
          <div>
            <p className="monoLabel">Provenance</p>
            <h2>Every claim has a block.</h2>
          </div>
          <button onClick={closeDrawer} type="button">Close</button>
        </div>
        <div className={styles.entries}>
          {entries.map((entry) => (
            <article key={`${entry.reference}-${entry.blockNumber}`}>
              <p>{entry.sourceType}</p>
              <strong>{entry.reference}</strong>
              <code>Block {entry.blockNumber}</code>
              <code>{entry.blockHash}</code>
            </article>
          ))}
        </div>
      </dialog>
    </>
  );
}
