# TR4CE Design System

**Design objective:** Make policy verdicts, uncertainty, and block provenance easier to read than a return metric.

## 1. Product character

TR4CE is a verifiable ERC-4626 evidence instrument. It is not a yield casino, generic AI dashboard, safety score, or autonomous trader.

The visual language is **botanical specimen sheet**: cream paper, deep-green ink, mechanical labels, restrained hairlines, and a single branching trace that connects a claim to a block. The result should feel calm, editorial, and technically exact.

Product truths:

1. Evidence precedes recommendation.
2. Unknown fails closed.
3. The wallet owner retains signing authority.
4. Historical share-value return is evidence, not a forecast or realized user P&L.
5. A visually strong screen must make limitations and provenance easier to find, never easier to miss.

## 2. Canonical logos

- `apps/web/public/icon-logo.png`: branching glyph for splash, compact navigation, favicon source, and empty states.
- `apps/web/public/text-logo.png`: TR4CE wordmark for desktop navigation and footer.
- The old construction-board `tr4ce-logo.png` is not rendered in UI.
- Use the supplied files without redrawing, recoloring, cropping, stretching, rotating, or shadowing them.
- Full lockup accessible name: `TR4CE: verifiable vault evidence`.
- Minimum desktop wordmark height: 18px. Minimum compact glyph: 24px.
- Use the dark-green export on cream or white. A white reversed export is permitted only after supplied source artwork includes it.

## 3. Tokens

```css
:root {
  --tr4ce-brand-50: #eef7f2;
  --tr4ce-brand-100: #d8ecdf;
  --tr4ce-brand-300: #82b49a;
  --tr4ce-brand-500: #167653;
  --tr4ce-brand-700: #035535;
  --tr4ce-brand-800: #01452c;
  --tr4ce-brand-900: #0b2f22;
  --tr4ce-cream-50: #fffaf2;
  --tr4ce-cream-100: #fdf3e5;
  --tr4ce-cream-200: #f5e6d3;
  --tr4ce-ink-950: #101814;
  --tr4ce-ink-800: #27332d;
  --tr4ce-ink-600: #526159;
  --tr4ce-ink-400: #66736c;
  --tr4ce-line: #c7d0ca;
  --tr4ce-surface: #ffffff;
  --tr4ce-info: #2563eb;
  --tr4ce-success: #137a45;
  --tr4ce-warning: #a15c00;
  --tr4ce-danger: #b42318;
  --tr4ce-unknown: #6b5aa6;
}
```

- Cream is the editorial canvas. White is operational paper.
- Brand green means identity, navigation, or primary action. It is not a substitute for PASS.
- PASS, FAIL, UNKNOWN, stale, and provenance always use independent semantic colors plus icon and visible text.
- Static cards use a 1px border and no shadow. Drawers and wallet-confirmation surfaces may use `0 16px 40px rgb(16 24 20 / 12%)`.
- Gradients, glass, neon, ambient texture, and rainbow data colors are prohibited.

## 4. Typography

Use `next/font` only. No render-blocking external font stylesheet.

- Display: Space Grotesk, 600.
- Body and controls: Inter, 400 or 500.
- Evidence, blocks, addresses, formulas, and amounts: IBM Plex Mono, 400 or 500, tabular numerals.

| Style | Desktop | Mobile | Line height |
|---|---:|---:|---:|
| Home display | 56-96px | 42-56px | 0.98-1.05 |
| H1 | 40-56px | 32-40px | 1.05-1.15 |
| H2 | 28px | 24px | 1.2 |
| H3 | 20px | 18px | 1.3 |
| Body | 16px | 16px | 1.55 |
| Evidence | 13-14px | 13px | 1.45 |

Eyebrows are 12px IBM Plex Mono, uppercase, 0.08em tracking, and deep green. Do not use condensed type for addresses or evidence.

## 5. Layout and material

- Maximum shell width: 1280px.
- Evidence report width: 880px.
- Grid: 12 columns desktop, 8 tablet, 4 mobile; 24px/20px/16px gutters.
- Home vertical rhythm: 128px desktop, 80px mobile.
- Operational vertical rhythm: 48px.
- Base spacing: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Control radius: 8px. Card radius: 12px. Pills are limited to status and compact metadata.
- The specimen frame uses 1px rules with small corner ticks. It is a framing device, not decoration around every component.

## 6. Canonical routes

- `/`: orientation and interactive policy-to-verdict proof.
- `/search`: policy builder, vault comparison, and address diagnostics.
- `/reports/[id]`: immutable evidence dossier and provenance.
- `/actions/[id]`: prepared action, simulation, wallet authority, and invalidation.
- `/evals`: fixed agent-evaluation evidence.

There are no route aliases. The browser does not calculate evidence and does not import `@tr4ce/evidence`.

## 7. Information hierarchy

Every report is ordered:

1. Vault identity and as-of context.
2. Policy result: PASS, FAIL, or UNKNOWN.
3. Observed share-value return and TVL in asset units.
4. Connected-account withdrawal evidence.
5. Net flows and history coverage.
6. Formula, raw inputs, source, block, and schema.
7. Limitations.
8. Prepared action.

Never lead with an annualized return. Every primary number shows units, time window, and a provenance entry point in the same visible region.

## 8. Components

### Status stamp

Required anatomy: icon, visible label, reason. UNKNOWN shows `? UNKNOWN` plus the reason. Missing data renders unavailable text, never zero.

### Evidence card

```text
[Metric]                                      [PASS | FAIL | UNKNOWN]
0.41% observed share-value return
7-day window · blocks 50,577,041 to 50,879,897
Threshold: at least 0.00%
[View calculation] [View sources]
```

Tooltips may explain terms but never hide required facts.

### Provenance chip and drawer

```text
● Base · block 50,879,897 · illustrative data
```

The chip opens a dialog showing source type, block hash, contract reference, method/event, schema version, timestamp, and explorer destination where available. The dialog traps focus, closes with Escape, and restores trigger focus.

### Policy panel

A policy has exactly five rules: asset, history, TVL, observed return, and withdrawal capacity. Show validation next to the affected field. Human language may draft policy, but the typed form is canonical.

### Comparison

Desktop uses a semantic table at 960px and up. Below 960px, show one complete vault card per result in the same order: identity, policy, completeness, observed value, status, reason. Default sort is status, completeness, then vault name. UNKNOWN never outranks PASS.

### Action preview

Always show network, connected wallet state, operation, vault and asset addresses, exact display and base-unit amount, receiver/owner, expected assets/shares, approval requirement, simulation block and expiry, gas estimate, warnings, and source limitations.

The primary button is `Confirm in wallet`. Never use `Execute safely` or `Earn now`.

## 9. States

The interface has distinct UI for:

- no selected vault
- loading
- fresh, refreshing, stale, partial, and reorged evidence
- unsupported address
- insufficient history
- failed read
- PASS, FAIL, UNKNOWN
- prepared action
- simulation in progress and failure
- unsigned transaction ready
- wallet rejection
- pending, confirmed, reverted, and receipt reconciliation failure

Examples:

| State | Copy | Action |
|---|---|---|
| Fresh | `Evidence current to block 50,879,897.` | View sources |
| Refreshing | `Updating current reads. Historical report remains available.` | None |
| Stale | `Current reads exceed the action limit.` | Refresh |
| Partial | `Required observations are unavailable.` | View missing evidence |
| Reorged | `The prior block was reorganized. This report is invalid.` | Regenerate |

## 10. Data visualization

- Share-value history uses an unsmoothed line. Gaps remain gaps.
- Deposits and withdrawals use separate bars.
- Highlight the exact start/end observations used in the report.
- Use USDC, not dollar signs, unless a separate sourced conversion exists.
- Do not use unlabeled dual axes.
- Every chart has an accessible title, description, and table alternative.

## 11. Copy

Use direct, verifiable language:

- `Observed over the last 30 days.`
- `Policy passed at block 50,879,897.`
- `Withdrawal capacity could not be verified.`
- `Prepare transaction.`
- `Simulation succeeded.`

Never use: safe vault, guaranteed yield, risk-free, AI verified, best vault without a named policy and metric, realized APY.

No em dash character appears in shipped UI copy, metadata, empty states, buttons, or labels. Use sentences, commas, parentheses, or colons.

## 12. Motion

Motion communicates state, orientation, or hierarchy.

- Hover, disclosure, row, and stamp transitions: 120-180ms.
- Drawer transitions: 200-240ms.
- Transform and opacity only; do not animate width, height, top, left, margin, or padding.
- CSS handles control feedback and disclosure.
- GSAP is restricted to the hero reveal, manifesto reveal, and one provenance SVG draw. It is client-only, scoped, cleaned up on unmount, and disabled under reduced motion.
- No animated money counters, looping decoration, parallax, cursor follower, or scroll hijacking.

## 13. Accessibility

- WCAG 2.2 AA text and control contrast.
- `:focus-visible` is a 2px brand-500 outline with 2px offset.
- Every critical path works by keyboard.
- Controls are at least 44px by 44px.
- `aria-live="polite"` for refreshed evidence; `assertive` only for action-blocking errors.
- Full addresses remain available to assistive technology when visually shortened.
- Wallet connection is never needed to explore read-only evidence.
- `prefers-reduced-motion` removes nonessential animation while preserving all state changes.

## 14. Acceptance criteria

- A first-time user can explain a failed or unknown rule without documentation.
- Every primary number has unit, window, and provenance entry point.
- UNKNOWN is distinct from zero and FAIL.
- Wrong chain, wrong asset, wrong receiver, and stale simulation are obvious before wallet confirmation.
- Mobile retains all evidence and approval information.
- Screens stay credible without a wallet and with illustrative or partial evidence.
