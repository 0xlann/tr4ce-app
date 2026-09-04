# TR4CE Design System

**Source mark:** [`tr4ce-logo.png`](../tr4ce-logo.png)  
**Design objective:** Make evidence, uncertainty, and provenance easier to read than the yield headline.

## 1. Brand foundation

The supplied mark combines a branching trace symbol with a technical wordmark. Its visual system is:

- **Botanical but precise:** the branching glyph suggests roots, lineage, and data paths.
- **Evidence-first:** the identity should feel like an instrument panel, not a casino.
- **Calm confidence:** cream and deep green carry the brand; status colors remain independent.
- **Mechanical typography:** `TR4CE` is always uppercase in brand contexts. Product prose uses “TR4CE.”

Do not redraw the logo from a font. Use the supplied asset until a canonical SVG is created from the source artwork.

## 2. Logo rules

- Minimum digital wordmark width: `160px`.
- Clear space: at least the width of the logo stem (`1x`) on every side, following the supplied construction image.
- Use the full dark-green mark on cream or white.
- A white reversed mark is permitted only on `brand-800` or darker.
- Never stretch, rotate, recolor individual glyphs, add shadows, or place the mark over noisy data visualization.
- Icon-only use requires the branching glyph exported from the original vector source; do not crop it from the raster image.
- Accessible name: `TR4CE — verifiable vault evidence`.

## 3. Color tokens

The primary colors were sampled from the supplied logo. Production values are normalized for stable UI use.

```css
:root {
  --tr4ce-brand-50:  #eef7f2;
  --tr4ce-brand-100: #d8ecdf;
  --tr4ce-brand-300: #82b49a;
  --tr4ce-brand-500: #167653;
  --tr4ce-brand-700: #035535;
  --tr4ce-brand-800: #01452c;
  --tr4ce-brand-900: #0b2f22;

  --tr4ce-cream-50:  #fffaf2;
  --tr4ce-cream-100: #fdf3e5;
  --tr4ce-cream-200: #f5e6d3;

  --tr4ce-ink-950: #101814;
  --tr4ce-ink-800: #27332d;
  --tr4ce-ink-600: #526159;
  --tr4ce-ink-400: #89958f;
  --tr4ce-line:    #d8ded9;
  --tr4ce-surface: #ffffff;

  --tr4ce-info:    #2563eb;
  --tr4ce-success: #137a45;
  --tr4ce-warning: #a15c00;
  --tr4ce-danger:  #b42318;
  --tr4ce-unknown: #6b5aa6;
}
```

### Usage

| Token | Use |
|---|---|
| `brand-700` | Primary action, active navigation, links on light surfaces |
| `cream-100` | Brand canvas, onboarding, empty states |
| `ink-950` | Primary text and numeric evidence |
| `info` | Source/provenance actions |
| `success` | A verified policy pass or confirmed transaction only |
| `warning` | Stale or degraded evidence |
| `danger` | Policy failure, simulation failure, destructive action |
| `unknown` | Missing or incompatible evidence; never style it as neutral success |

Brand green and semantic success green must remain visibly different. Every status includes an icon and text label.

## 4. Typography

Use local/system-safe assets through `next/font`; no render-blocking external CSS.

- **Display and headings:** `Space Grotesk`, fallback `Inter, system-ui, sans-serif`.
- **Body and UI:** `Inter`, fallback `system-ui, sans-serif`.
- **Evidence values/code:** `IBM Plex Mono`, fallback `ui-monospace, SFMono-Regular, monospace`.
- **Logo:** supplied artwork only.

| Style | Desktop | Mobile | Weight | Line height |
|---|---:|---:|---:|---:|
| Display | 56px | 40px | 600 | 1.05 |
| H1 | 40px | 32px | 600 | 1.15 |
| H2 | 28px | 24px | 600 | 1.25 |
| H3 | 20px | 18px | 600 | 1.35 |
| Body | 16px | 16px | 400 | 1.55 |
| Small | 14px | 14px | 450 | 1.45 |
| Evidence | 14px | 13px | 500 | 1.45 |

Use tabular numerals for amounts. Never use condensed type for addresses or evidence.

## 5. Spacing, radius, and elevation

Base unit: `4px`.

- Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64, 96`.
- Card radius: `12px`.
- Input/button radius: `8px`.
- Evidence chips: `999px`, but never turn every label into a pill.
- Default border: `1px solid var(--tr4ce-line)`.
- Default card shadow: none. Use border and surface contrast.
- Floating transaction confirmation may use `0 16px 40px rgb(16 24 20 / 12%)`.

Dense financial tables use 12px vertical cell padding; touch targets remain at least `44x44px`.

## 6. Layout

- Maximum content width: `1280px`.
- Reading/evidence report width: `880px`.
- Desktop app shell: `240px` navigation + fluid content.
- Comparison table appears at `>= 960px`; below that, one vault per semantic card.
- Grid: 12 columns desktop, 8 tablet, 4 mobile; 24px/20px/16px gutters.
- Keep the main evidence and policy result above promotional or explanatory content.

## 7. Information hierarchy

Every vault report follows this order:

1. Vault identity and as-of context.
2. Policy result (`PASS`, `FAIL`, `UNKNOWN`).
3. Observed share-value return and TVL in underlying asset units.
4. Redemption evidence for the connected account.
5. Net flows and history coverage.
6. Formula, raw observations, source, block, and schema.
7. Limitations.
8. Prepared action.

Never lead with annualized return alone.

## 8. Core components

### 8.1 Evidence Card

Required anatomy:

```text
[Metric name]                       [PASS | FAIL | UNKNOWN]
1.08% observed share-value return
30-day window · blocks 24,100,012 → 24,500,123
Threshold: ≥ 0.00%
[View calculation] [View sources]
```

Rules:

- Use “observed share-value return,” not “yield earned.”
- Show window and raw block range without opening a tooltip.
- A missing start observation renders `—` plus `UNKNOWN`, never `0`.
- Tooltips explain terms but never contain required evidence exclusively.

### 8.2 Provenance Chip

Compact source reference:

```text
● Ethereum · block 24,500,123 · 38s old
```

Click opens a provenance drawer containing endpoint type, block hash, contract, method/event, schema version, indexed timestamp, and explorer link.

### 8.3 Policy Rule Row

Columns: rule, operator, threshold, observed value, status, reason. On mobile, preserve that sequence vertically.

### 8.4 Vault Comparison

- Sticky identity column on wide screens.
- Sort only by explicitly selected metric.
- Default order: overall policy status, then data completeness, then vault name; not highest return.
- An `UNKNOWN` row cannot rank above a passing row.

### 8.5 Action Preview

Must show:

- network and connected wallet;
- operation;
- vault and underlying token addresses;
- exact base/display amount;
- receiver/owner;
- expected shares/assets;
- approval transaction, if required;
- simulation block and expiry;
- gas estimate and warnings.

Primary button copy: `Confirm in wallet`. Never `Execute safely` or `Earn now`.

### 8.6 Limitation Callout

Cream or neutral background, not warning-red unless action is blocked.

> Historical share-value change is backward-looking. ERC-4626 does not standardize strategy safety, governance, or future liquidity.

### 8.7 Data-state banner

| State | Copy pattern | Action |
|---|---|---|
| Fresh | “Evidence current to block …” | View sources |
| Refreshing | “Updating current reads; historical report remains available.” | None |
| Stale | “Current reads exceed the 3-block action limit.” | Refresh |
| Partial | “2 required observations are unavailable.” | View missing evidence |
| Reorged | “The prior block was reorganized; this report is invalid.” | Regenerate |

## 9. Screen specifications

### 9.1 Search / policy builder

- Plain-language input is optional assistance, not the canonical policy.
- Always render the resulting typed five-rule form.
- Display validation beside the affected field.
- Confirmation action: `Use this policy`.

### 9.2 Results

- Summary: count passing, failing, unknown.
- Filters retain user policy context.
- Each result exposes data completeness and as-of block.
- No decorative chart is shown until the exact metric and units are readable.

### 9.3 Evidence report

- Stable report URL.
- Human view plus `View JSON` and `Copy report ID`.
- Calculation disclosure uses numerator, denominator, formula, rounding, and inputs.
- Source timeline distinguishes indexed historical data from current RPC reads.

### 9.4 Transaction flow

Three visible steps: `Prepared` → `Simulated` → `Wallet confirmed`. Submission and confirmation are separate states.

### 9.5 Agent evaluation

Show fixed prompt, environment, raw baseline, TR4CE result, and scoring rubric. Do not use a vanity “agent intelligence” score.

## 10. Data visualization

- Use lines for share-value history; use bars for deposits/withdrawals.
- Do not combine return and TVL on unlabeled dual axes.
- Every chart has a table alternative.
- Never smooth financial observations.
- Gaps remain gaps. Do not interpolate unavailable blocks.
- Highlight the exact start/end points used by the report.
- Use asset units by default (`USDC`), not `$`, unless a separately sourced USD conversion is present.

## 11. Voice and copy

### Use

- “Observed over the last 30 days.”
- “Policy passed at block 24,500,123.”
- “Withdrawal capacity could not be verified.”
- “Prepare transaction.”
- “Simulation succeeded.”

### Never use

- “Safe vault.”
- “Guaranteed yield.”
- “Risk-free.”
- “AI verified.”
- “Best vault” without naming the selected policy and metric.
- “Realized APY” for vault-level `convertToAssets` history.

## 12. Motion

- 120–180ms for hover, disclosure, and table-state transitions.
- 200–240ms for drawers/modals.
- No animated counters for money.
- No looping decorative motion in evidence or transaction flows.
- Respect `prefers-reduced-motion`; state changes remain understandable without animation.

## 13. Accessibility checklist

- WCAG 2.2 AA text and control contrast.
- Visible focus ring: `2px solid brand-500`, 2px offset.
- Full keyboard operation and logical focus return from drawers/modals.
- `aria-live="polite"` for refreshed evidence; `assertive` only for transaction-blocking errors.
- Status icon + label + explanatory text.
- Addresses expose full value to assistive technology even when visually truncated.
- Charts include accessible title, description, and data table.
- Wallet connection is never the only way to explore read-only evidence.

## 14. Design acceptance criteria

- A first-time user can state why one vault failed without opening documentation.
- Every primary number has visible units, time window, and provenance entry point.
- `UNKNOWN` is visually and semantically distinct from zero and failure.
- The action preview makes wrong chain, wrong asset, wrong receiver, and stale simulation obvious.
- Mobile retains the same evidence and approval information as desktop.
- Product screenshots remain credible with no wallet connected and with partial provider failure.
