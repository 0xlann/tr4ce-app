"use client";

import { useReducer } from "react";

import { mockVaults, reportRules } from "./mock-data";
import { advancePrototypeFlow, initialPrototypeState, type ActionStatus } from "../src/prototype-flow";

type Status = "PASS" | "FAIL" | "UNKNOWN";

function StatusBadge({ status }: { status: Status }) {
  const label = status === "PASS" ? "Policy passed" : status === "FAIL" ? "Policy failed" : "Evidence unknown";

  return <span className={`status status--${status.toLowerCase()}`}><span aria-hidden="true">{status === "PASS" ? "✓" : status === "FAIL" ? "×" : "?"}</span>{status}<span className="sr-only">: {label}</span></span>;
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <header className="section-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></header>;
}

export function PrototypeApp() {
  const [state, dispatch] = useReducer(advancePrototypeFlow, initialPrototypeState);
  const selectedVault = mockVaults.find((vault) => vault.id === state.selectedVaultId) ?? mockVaults[0];
  if (!selectedVault) {
    throw new Error("Prototype fixtures must contain the selected vault.");
  }

  return <main>
    <header className="topbar">
      <button className="brand" onClick={() => dispatch({ type: "OPEN_COMPARE" })} aria-label="TR4CE home"><img src="/tr4ce-logo.png" alt="TR4CE — verifiable vault evidence" /></button>
      <nav aria-label="Primary navigation"><button className={state.screen === "compare" ? "active" : ""} onClick={() => dispatch({ type: "OPEN_COMPARE" })}>Compare vaults</button><button onClick={() => dispatch({ type: "OPEN_REPORT", vaultId: "cedar" })}>Evidence report</button><button onClick={() => dispatch({ type: "PREPARE_DEPOSIT" })}>Prepare action</button></nav>
      <span className="prototype-label">Prototype · illustrative data</span>
    </header>

    <div className="evidence-strip"><span className="source-dot" /> Evidence current to Ethereum block <strong>24,500,123</strong><span>·</span><span>Historical flows indexed; current reads simulated.</span></div>

    {state.screen === "compare" && <CompareScreen onInspect={(vaultId) => dispatch({ type: "OPEN_REPORT", vaultId })} />}
    {state.screen === "report" && <ReportScreen vault={selectedVault} onBack={() => dispatch({ type: "OPEN_COMPARE" })} onPrepare={() => dispatch({ type: "PREPARE_DEPOSIT" })} />}
    {state.screen === "action" && <ActionScreen actionStatus={state.actionStatus} onBack={() => dispatch({ type: "OPEN_REPORT", vaultId: state.selectedVaultId })} onSimulate={() => dispatch({ type: "SIMULATE_SUCCESS" })} onFail={() => dispatch({ type: "SIMULATE_FAILURE" })} onWallet={() => dispatch({ type: "REQUEST_WALLET" })} onInvalidate={() => dispatch({ type: "WALLET_CONTEXT_CHANGED" })} />}
  </main>;
}

function CompareScreen({ onInspect }: { onInspect: (vaultId: string) => void }) {
  return <div className="page-shell">
    <SectionHeading eyebrow="Curated USDC ERC-4626 vaults" title="Trace every vault decision back to evidence." detail="A typed policy evaluates reproducible observations. This prototype does not query a wallet, network, or provider." />
    <section className="policy-panel" aria-labelledby="policy-title"><div><p className="eyebrow">Policy v1 · typed and reviewable</p><h2 id="policy-title">Vault Evidence Check v1</h2></div><dl><div><dt>Asset</dt><dd>USDC</dd></div><div><dt>History</dt><dd>≥ 30 days</dd></div><div><dt>TVL</dt><dd>≥ 2.00m USDC</dd></div><div><dt>Return</dt><dd>≥ 0.00% / 7d</dd></div><div><dt>Withdrawal</dt><dd>≥ 10,000 USDC</dd></div></dl><button className="secondary">Edit policy</button></section>
    <section className="results-summary" aria-label="Comparison summary"><div><strong>1</strong><span>passing</span></div><div><strong>1</strong><span>failing</span></div><div><strong>1</strong><span>unknown</span></div><p>Sorted by policy status, then completeness—not return.</p></section>
    <section className="vault-table" aria-labelledby="comparison-title"><div className="table-head"><h2 id="comparison-title">Policy results</h2><span>As of block 24,500,123</span></div><div className="vault-rows">{mockVaults.map((vault) => <article key={vault.id} className="vault-row"><div className="vault-name"><h3>{vault.name}</h3><p>{vault.network} · {vault.protocol}</p><code>{vault.address}</code></div><div><span className="data-label">Policy</span><StatusBadge status={vault.status} /></div><div><span className="data-label">Completeness</span><strong>{vault.completeness}%</strong></div><div><span className="data-label">Observed return</span><strong>{vault.returnLabel}</strong></div><div><span className="data-label">TVL</span><strong>{vault.tvl}</strong></div><div><span className="data-label">Withdrawable</span><strong>{vault.withdrawable}</strong></div><button className="text-button" onClick={() => onInspect(vault.id)}>Inspect evidence <span aria-hidden="true">→</span></button><p className="row-reason">{vault.reason}</p></article>)}</div></section>
    <aside className="limitation"><strong>What this does not prove</strong><p>Historical share-value change is backward-looking. ERC-4626 does not standardize strategy safety, governance, or future liquidity.</p></aside>
  </div>;
}

function ReportScreen({ vault, onBack, onPrepare }: { vault: typeof mockVaults[number]; onBack: () => void; onPrepare: () => void }) {
  return <div className="report-layout"><button className="back" onClick={() => onBack()}>← Comparison</button><article className="report"><header className="report-header"><div><p className="eyebrow">Evidence report · trc_demo_pass · schema 1.0.0</p><h1>{vault.name}</h1><p>{vault.network} · <code>{vault.address}</code> · illustrative registry entry</p></div><StatusBadge status={vault.status} /></header><div className="report-context"><span>As of <strong>block 24,500,123</strong></span><span>2026-09-02 12:00 UTC</span><span>share-value-v1</span></div><section className="primary-evidence"><div><p className="eyebrow">Observed share-value return</p><strong>+0.41%</strong><p>over 7 days · blocks 24,100,012 → 24,500,123</p></div><div><p className="eyebrow">Total assets</p><strong>4.20m <small>USDC</small></strong><p>Raw totalAssets() at report block</p></div><div><p className="eyebrow">Withdrawal capacity</p><strong>25,000 <small>USDC</small></strong><p>Connected owner · capability verified</p></div></section><section className="rule-section"><div className="section-line"><div><p className="eyebrow">Typed policy</p><h2>Every rule is visible</h2></div><span>Overall result only passes when all rules pass.</span></div><div className="rule-table">{reportRules.map(([name, operator, threshold, observed, status, reason]) => <div className="rule-row" key={name}><strong>{name}</strong><span>{operator} {threshold}</span><span>{observed}</span><StatusBadge status={status as Status} /><span>{reason}</span></div>)}</div></section><section className="calculation"><div><p className="eyebrow">Calculation disclosure</p><h2>One-share conversion, exact inputs</h2></div><code>(1,052,300 / 1,041,000 − 1) × 10,000 = 108 bps</code><p>Historical `convertToAssets(one share)` observations are compared with integer arithmetic; rounding direction: down toward zero.</p><details><summary>View raw observations and provenance</summary><pre>{JSON.stringify({ source: "indexed historical snapshots + current RPC", block: "24500123", blockHash: "0xaaaaaaaa…aaaaaaaa", startAssets: "1041000", endAssets: "1052300", reportId: "trc_demo_pass" }, null, 2)}</pre></details></section><section className="report-action"><div><p className="eyebrow">Action remains user-controlled</p><h2>Prepare a 100.00 USDC deposit</h2><p>TR4CE will build an unsigned exact approval and deposit request, simulate them, then show the wallet owner the final transaction.</p></div><button className="primary" onClick={onPrepare}>Prepare transaction</button></section></article></div>;
}

function ActionScreen({ actionStatus, onBack, onSimulate, onFail, onWallet, onInvalidate }: { actionStatus: ActionStatus; onBack: () => void; onSimulate: () => void; onFail: () => void; onWallet: () => void; onInvalidate: () => void }) {
  const ready = actionStatus === "simulated";
  const failed = actionStatus === "simulation-failed" || actionStatus === "invalidated";
  return <div className="action-page"><button className="back" onClick={onBack}>← Evidence report</button><SectionHeading eyebrow="Prepared action · illustrative only" title="Review exact action before any signature." detail="No wallet is connected. These controls expose the state machine for product audit." /><ol className="action-steps"><li className="done">Prepared</li><li className={ready ? "done" : ""}>Simulated</li><li className={actionStatus === "wallet-ready" ? "done" : ""}>Wallet confirmed</li></ol><section className="action-grid"><article className="action-card"><p className="eyebrow">Deposit</p><dl><div><dt>Network</dt><dd>Ethereum</dd></div><div><dt>Vault</dt><dd><code>0x7C31…A920</code></dd></div><div><dt>Asset</dt><dd>USDC · <code>0xA0b8…eB48</code></dd></div><div><dt>Amount</dt><dd>100.00 USDC <small>(100000000 base units)</small></dd></div><div><dt>Receiver</dt><dd><code>0x71c…A920</code></dd></div><div><dt>Expected shares</dt><dd>98.7341</dd></div></dl></article><aside className={`simulation ${failed ? "simulation--failed" : ""}`} aria-live="polite"><p className="eyebrow">Simulation</p><h2>{actionStatus === "prepared" ? "Ready to simulate" : actionStatus === "simulated" ? "Simulation succeeded" : actionStatus === "wallet-ready" ? "Ready for wallet approval" : actionStatus === "simulation-failed" ? "Simulation failed" : "Simulation invalidated"}</h2><p>{actionStatus === "prepared" ? "Bound to the current account, calldata, and selected block." : actionStatus === "simulated" ? "Block 24,500,130 · expires in 3 blocks or 60 seconds." : actionStatus === "wallet-ready" ? "The wallet owner must explicitly approve the exact transaction." : actionStatus === "simulation-failed" ? "Illustrative revert: vault paused. No wallet request may proceed." : "Account, chain, amount, receiver, or block changed. Prepare again."}</p><dl><div><dt>Approval</dt><dd>Exact 100.00 USDC only</dd></div><div><dt>Gas estimate</dt><dd>142,000</dd></div></dl>{actionStatus === "prepared" && <div className="button-stack"><button className="primary" onClick={onSimulate}>Run simulation</button><button className="secondary" onClick={onFail}>Show failed simulation</button></div>}{ready && <div className="button-stack"><button className="primary" onClick={onWallet}>Confirm in wallet</button><button className="secondary" onClick={onInvalidate}>Change wallet context</button></div>}</aside></section></div>;
}
