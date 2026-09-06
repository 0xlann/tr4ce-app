# TR4CE Task 9 Frontend Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock-only prototype with an original, responsive, evidence-first Task 9 web product on canonical routes.

**Architecture:** The App Router renders five canonical surfaces. A single client-safe fixture module returns validated domain-shaped reports, policies, and prepared actions while Tasks 5 and 6 remain unavailable. Server evidence calculation stays in `@tr4ce/evidence`; web components consume contracts from `@tr4ce/domain` and never recalculate token values.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, CSS Modules plus global token layer, `next/font`, inline SVG, Vitest, GSAP plus `@gsap/react` for three client-only narrative sequences.

**Spec:** `docs/superpowers/specs/2026-09-06-tr4ce-task9-frontend-rebuild-design.md`

## Global Constraints

- Canonical routes are `/`, `/search`, `/reports/[id]`, `/actions/[id]`, `/evals`; create no aliases.
- Use `icon-logo.png` and `text-logo.png`; do not render the old `tr4ce-logo.png` in UI.
- The browser imports types/contracts from `@tr4ce/domain` but never imports `@tr4ce/evidence` or executes evidence calculations.
- All temporary values are visibly labelled illustrative. Never imply a live provider, wallet, transaction, or production vault claim.
- No em dash character is permitted in shipped UI content or metadata.
- Do not add chart, icon, UI, styling, animation, or state-management dependencies. Add only `gsap` and `@gsap/react`.
- Status is always icon + visible label + explanation, never color alone. UNKNOWN is not zero.
- No animated money counters, parallax, looping decoration, or layout-property animation.
- Every interactive control has keyboard access, 44px minimum touch target, and visible focus.
- Test pure behavior first. Use the actual running Next surface for visual, mobile, keyboard, and reduced-motion verification.

---

### Task 1: Install the visual foundation and canonical brand assets

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/styles/globals.css`
- Modify: `docs/DESIGN-SYSTEMS.md`
- Create: `apps/web/components/ui/LogoLockup.tsx`
- Create: `apps/web/components/ui/LogoLockup.module.css`

**Interfaces:**
- Produces `LogoLockup({ compact?: boolean; className?: string })`.
- Produces global CSS variables for color, type, motion, layout, focus, and status tokens.
- `layout.tsx` supplies `--font-display`, `--font-body`, and `--font-mono` to the document body.

- [ ] **Step 1: Implement the asset contract and visual foundation**

- Add `gsap` and `@gsap/react` to `apps/web/package.json`.
- Load `Inter`, `Space_Grotesk`, and `IBM_Plex_Mono` using `next/font/google` in `layout.tsx` with CSS variables and `display: "swap"`.
- Replace metadata title with `TR4CE: verifiable vault evidence`.
- Implement `LogoLockup` with `/icon-logo.png` plus `/text-logo.png`, `alt="TR4CE: verifiable vault evidence"`, and compact icon-only mode.
- Rewrite `globals.css` to contain only tokens, base element rules, accessibility utilities, skip link, global focus ring, screen-reader utility, specimen-frame utility, and reduced-motion override.
- Update `docs/DESIGN-SYSTEMS.md` to match the new exports, route model, token law, typography, specimen-frame motif, no-em-dash rule, motion rules, and state contract.

- [ ] **Step 2: Build and visually verify the foundation**

Run: `pnpm exec turbo run typecheck build --filter=@tr4ce/web`

Then load `/` in a browser and verify that the self-hosted font families are present in computed styles, the logo uses both new assets without guide marks, and keyboard Tab shows the global focus ring.

Expected: web typecheck and production build pass; no old construction-sheet logo is visible.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json apps/web/app/layout.tsx apps/web/styles/globals.css apps/web/components/ui/LogoLockup.tsx apps/web/components/ui/LogoLockup.module.css docs/DESIGN-SYSTEMS.md pnpm-lock.yaml
git commit -m "feat(web): establish Tr4ce visual foundation"
```

### Task 2: Establish validated illustrative data and policy preset behavior

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/demo/fixtures.ts`
- Create: `apps/web/src/demo/fixtures.test.ts`
- Create: `apps/web/src/demo/types.ts`

**Interfaces:**

```ts
export type PolicyPreset = "strict" | "balanced" | "lenient";
export type VaultSummary = {
  id: string;
  name: string;
  protocol: string;
  network: string;
  address: string;
  completeness: number;
  report: EvidenceReportV1;
};
export function getPolicyPreset(preset: PolicyPreset): PolicyV1;
export function getVaultSummaries(preset: PolicyPreset): readonly VaultSummary[];
export function getReport(id: string, preset?: PolicyPreset): EvidenceReportV1 | undefined;
export function getPreparedAction(id: string): PreparedActionV1 | undefined;
```

- [ ] **Step 1: Write failing fixture behavior tests**

```ts
import { describe, expect, it } from "vitest";
import { getPolicyPreset, getVaultSummaries } from "./fixtures.js";

describe("illustrative policy fixtures", () => {
  it("orders PASS before FAIL before UNKNOWN for the balanced policy", () => {
    expect(getVaultSummaries("balanced").map((vault) => vault.report.policy.status)).toEqual([
      "PASS", "FAIL", "UNKNOWN",
    ]);
  });

  it("changes the policy threshold without fabricating a policy pass", () => {
    const strict = getPolicyPreset("strict");
    const lenient = getPolicyPreset("lenient");
    expect(strict.minTvlAssets).not.toBe(lenient.minTvlAssets);
    expect(getVaultSummaries("strict").some((vault) => vault.report.policy.status === "UNKNOWN")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the provider is missing**

Run: `pnpm --filter @tr4ce/web test -- fixtures.test.ts`

Expected: module resolution fails for `./fixtures.js`.

- [ ] **Step 3: Implement the fixture provider**

- Add `@tr4ce/domain: "workspace:*"` to web dependencies.
- Build static fixtures using `evidenceReportV1Schema.parse`, `policyV1Schema.parse`, and `preparedActionV1Schema.parse`.
- Include a PASS report, a FAIL report, and an UNKNOWN report. UNKNOWN has a null `maxWithdrawAssets`, `AMBIGUOUS_CAPABILITY` reason, and no zero substitute.
- Use valid Base addresses, block hashes, ISO timestamps, decimal-string amounts, source provenance, and explicit `Illustrative data` UI metadata. Fixtures must not claim provider freshness.
- Keep all preset evaluation static and deterministic. Do not call the evidence engine or use token floating point.

- [ ] **Step 4: Run the fixture test and contract typecheck**

Run: `pnpm exec turbo run test typecheck --filter=@tr4ce/web`

Expected: fixture behavior test passes; all fixture contracts parse.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/demo pnpm-lock.yaml
git commit -m "feat(web): add validated illustrative evidence fixtures"
```

### Task 3: Build reusable evidence UI primitives

**Files:**
- Create: `apps/web/components/ui/StatusStamp.tsx`
- Create: `apps/web/components/ui/StatusStamp.module.css`
- Create: `apps/web/components/ui/BlockRuler.tsx`
- Create: `apps/web/components/ui/ProvenanceChip.tsx`
- Create: `apps/web/components/ui/ProvenanceDrawer.tsx`
- Create: `apps/web/components/ui/DataStateBanner.tsx`
- Create: `apps/web/components/ui/LimitationCallout.tsx`
- Create: `apps/web/components/ui/SectionHeading.tsx`
- Create: `apps/web/components/ui/TopNav.tsx`
- Create: `apps/web/components/ui/Footer.tsx`

**Interfaces:**

```ts
export function StatusStamp({ status, reason, size }: {
  status: PolicyRuleStatus;
  reason: string;
  size?: "compact" | "feature";
}): JSX.Element;

export function ProvenanceDrawer({ entries, open, onClose }: {
  entries: readonly ProvenanceEntry[];
  open: boolean;
  onClose(): void;
}): JSX.Element;
```

- [ ] **Step 1: Write failing status presentation tests**

```ts
import { describe, expect, it } from "vitest";
import { statusPresentation } from "./status-presentation.js";

describe("status presentation", () => {
  it("gives UNKNOWN a visible label and question icon", () => {
    expect(statusPresentation("UNKNOWN")).toEqual({ icon: "?", label: "UNKNOWN" });
  });

  it("does not describe UNKNOWN as zero", () => {
    expect(statusPresentation("UNKNOWN").label).not.toContain("0");
  });
});
```

Create `apps/web/components/ui/status-presentation.ts` and `status-presentation.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tr4ce/web test -- status-presentation.test.ts`

Expected: module resolution fails for `./status-presentation.js`.

- [ ] **Step 3: Implement primitives**

- `statusPresentation` returns exactly `{ icon: "✓", label: "PASS" }`, `{ icon: "×", label: "FAIL" }`, or `{ icon: "?", label: "UNKNOWN" }`.
- `StatusStamp` renders icon, label, and reason text. It has no color-only variant.
- `BlockRuler` renders a labelled start/end block axis with inline SVG tick marks.
- `ProvenanceChip` controls `ProvenanceDrawer`; drawer has dialog semantics, Escape closing, focus restoration, and source type/block/reference rows.
- `TopNav` uses `LogoLockup` and canonical route links. `Footer` links to every route and includes illustrative-data limitations.
- Use CSS Modules for each component; no component selectors return to `globals.css`.

- [ ] **Step 4: Run primitive tests and typecheck**

Run: `pnpm exec turbo run test typecheck --filter=@tr4ce/web`

Expected: status tests pass and the web package typechecks.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/ui
git commit -m "feat(web): add evidence interface primitives"
```

### Task 4: Build the editorial home and policy-to-verdict hero

**Files:**
- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/components/home/HomeHero.tsx`
- Create: `apps/web/components/home/HomeHero.module.css`
- Create: `apps/web/components/home/Manifesto.tsx`
- Create: `apps/web/components/home/TraceDiagram.tsx`
- Create: `apps/web/components/home/ReportSpecimen.tsx`
- Create: `apps/web/components/home/OutcomeExplainer.tsx`
- Create: `apps/web/components/home/ActionPreviewStage.tsx`
- Create: `apps/web/components/home/HomePage.tsx`

**Interfaces:**

```ts
export function HomeHero(): JSX.Element;
export function TraceDiagram(): JSX.Element;
```

- [ ] **Step 1: Write failing hero-state test**

```ts
import { describe, expect, it } from "vitest";
import { initialHeroState, reduceHeroState } from "./hero-state.js";

describe("hero policy control", () => {
  it("changes the active preset when a user chooses strict", () => {
    expect(reduceHeroState(initialHeroState, { type: "SELECT_PRESET", preset: "strict" }).preset).toBe("strict");
  });
});
```

Create `apps/web/components/home/hero-state.ts` and `hero-state.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tr4ce/web test -- hero-state.test.ts`

Expected: module resolution fails for `./hero-state.js`.

- [ ] **Step 3: Implement home experience**

- Hero uses `useReducer(reduceHeroState, initialHeroState)` with Strict, Balanced, Lenient controls and `getVaultSummaries`.
- Each result row exposes name, status stamp, one visible reason, and an illustrative block tick.
- Implement the manifesto, one inline-SVG provenance trace, report specimen, outcome explainer, exact action preview stage, limitation callout, and footer. Every section uses real internal components and links to canonical routes.
- Add GSAP only in the client component: scoped `useGSAP`, word reveal, one SVG path draw; apply `gsap.matchMedia()` and skip motion for reduced motion. No number counters.

- [ ] **Step 4: Run hero tests and a Next build**

Run: `pnpm exec turbo run test typecheck build --filter=@tr4ce/web`

Expected: hero test passes and Next produces a production build.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/components/home
git commit -m "feat(web): build editorial evidence home"
```

### Task 5: Build search and report routes

**Files:**
- Create: `apps/web/app/search/page.tsx`
- Create: `apps/web/app/reports/[id]/page.tsx`
- Create: `apps/web/components/policy/PolicyPanel.tsx`
- Create: `apps/web/components/policy/PolicyPanel.module.css`
- Create: `apps/web/components/evidence/VaultResults.tsx`
- Create: `apps/web/components/evidence/VaultResults.module.css`
- Create: `apps/web/components/evidence/ReportDossier.tsx`
- Create: `apps/web/components/evidence/ReportDossier.module.css`
- Create: `apps/web/components/evidence/ShareValueChart.tsx`
- Create: `apps/web/components/evidence/FlowBars.tsx`

**Interfaces:**

```ts
export function compareVaults(vaults: readonly VaultSummary[]): readonly VaultSummary[];
export function ReportDossier({ report }: { report: EvidenceReportV1 }): JSX.Element;
```

- [ ] **Step 1: Write failing comparison-order test**

```ts
import { expect, it } from "vitest";
import { compareVaults } from "./compare-vaults.js";

it("never ranks UNKNOWN above PASS", () => {
  const order = compareVaults(getVaultSummaries("balanced")).map((vault) => vault.report.policy.status);
  expect(order.indexOf("PASS")).toBeLessThan(order.indexOf("UNKNOWN"));
});
```

Create `apps/web/components/evidence/compare-vaults.ts` and `compare-vaults.test.ts`, importing `getVaultSummaries` from the fixture module.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tr4ce/web test -- compare-vaults.test.ts`

Expected: module resolution fails for `./compare-vaults.js`.

- [ ] **Step 3: Implement search and report routes**

- `/search` pairs policy panel with sorted results. Use a semantic table above 960px and complete vault cards below it.
- Each vault row/card shows policy, completeness, observed return with window, TVL, withdrawable assets, and a human-readable reason. Address lookup has supported and unsupported illustrative diagnostics.
- `/reports/[id]` looks up only recognised fixture report IDs and uses `notFound()` otherwise.
- Report dossier follows the eight-item hierarchy. It includes BlockRuler, provenance drawer, JSON view, copy report ID button, unsmoothed inline SVG share-value history with an accessible table alternative, flow bars, and limitation callout.

- [ ] **Step 4: Run tests and build**

Run: `pnpm exec turbo run test typecheck build --filter=@tr4ce/web`

Expected: ordering test passes and both routes compile.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/search apps/web/app/reports apps/web/components/policy apps/web/components/evidence
git commit -m "feat(web): add search and evidence report routes"
```

### Task 6: Build action and evaluation routes; remove prototype

**Files:**
- Modify: `apps/web/src/prototype-flow.ts`
- Modify: `apps/web/src/prototype-flow.test.ts`
- Create: `apps/web/app/actions/[id]/page.tsx`
- Create: `apps/web/app/evals/page.tsx`
- Create: `apps/web/components/actions/ActionConsole.tsx`
- Create: `apps/web/components/actions/ActionConsole.module.css`
- Create: `apps/web/components/actions/ActionStepper.tsx`
- Create: `apps/web/components/evals/EvaluationSurface.tsx`
- Delete: `apps/web/components/PrototypeApp.tsx`
- Delete: `apps/web/components/mock-data.ts`

**Interfaces:**

```ts
export type ActionStatus = "prepared" | "simulated" | "wallet-ready" | "simulation-failed" | "invalidated" | "wallet-rejected" | "pending" | "confirmed" | "reverted" | "receipt-reconciliation-failed";
export function advanceActionState(state: ActionStatus, event: ActionEvent): ActionStatus;
```

- [ ] **Step 1: Write failing action-expiry test**

```ts
import { expect, it } from "vitest";
import { advanceActionState } from "./prototype-flow.js";

it("invalidates a simulated action after the chain or wallet changes", () => {
  expect(advanceActionState("simulated", { type: "CONTEXT_CHANGED" })).toBe("invalidated");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tr4ce/web test -- prototype-flow.test.ts`

Expected: the old reducer has no `advanceActionState` export.

- [ ] **Step 3: Implement action and eval surfaces**

- Replace screen routing state with a focused action-status reducer and preserve existing `SIMULATE_SUCCESS`, `SIMULATE_FAILURE`, and context invalidation semantics.
- `/actions/[id]` looks up only recognised fixture actions and calls `notFound()` otherwise.
- Action console displays required operation, network, vault, asset, owner, receiver, decimal-string amount, unsigned transaction, simulation block/hash/expiry/gas, and all success/failure branches.
- `/evals` displays fixed prompt, environment, baseline result, TR4CE result, and rubric. It must not show vanity scores.
- Delete `PrototypeApp.tsx` and `mock-data.ts`; no obsolete aliases remain.

- [ ] **Step 4: Run web tests and build**

Run: `pnpm exec turbo run test typecheck build --filter=@tr4ce/web`

Expected: action tests pass, deleted prototype imports are absent, and canonical routes compile.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/actions apps/web/app/evals apps/web/components/actions apps/web/components/evals apps/web/src/prototype-flow.ts apps/web/src/prototype-flow.test.ts
git rm apps/web/components/PrototypeApp.tsx apps/web/components/mock-data.ts
git commit -m "feat(web): add action and evaluation surfaces"
```

### Task 7: Verify actual user experience and clean generated artifacts

**Files:**
- Modify if needed: exact component/style files identified by visual audit
- Do not retain: temporary screenshots, prototype imports, old logo UI references, em-dash UI copy

- [ ] **Step 1: Start the actual Next application**

Run: `pnpm --filter @tr4ce/web dev`

Expected: Next reports a local URL and serves `/`.

- [ ] **Step 2: Exercise canonical desktop routes**

Use browser automation to load `/`, `/search`, `/reports/cedar`, `/actions/deposit-cedar`, and `/evals`.

Expected:

- Hero preset updates verdict rows without animated money.
- Search preserves PASS, FAIL, UNKNOWN ordering.
- Report opens and closes provenance drawer with Escape.
- Action context change invalidates wallet confirmation.
- Each route has no em dash in rendered page text.

- [ ] **Step 3: Exercise mobile, keyboard, and reduced-motion states**

Use a 390px viewport, keyboard Tab/Enter/Escape, and `prefers-reduced-motion: reduce`.

Expected:

- Mobile contains every evidence/approval fact available on desktop.
- All interactive controls show focus and are keyboard operable.
- Reduced-motion mode shows complete states with no GSAP reveal or SVG draw animation.

- [ ] **Step 4: Run final automated contract checks**

Run: `pnpm exec turbo run test typecheck build --filter=@tr4ce/web && pnpm exec turbo run test typecheck --filter=@tr4ce/evidence`

Expected: all web and evidence tasks pass.

- [ ] **Step 5: Commit verified final state**

```bash
git add apps/web docs/DESIGN-SYSTEMS.md pnpm-lock.yaml
git commit -m "feat(web): ship evidence-first Task 9 interface"
```

## Plan self-review

- Spec coverage: Tasks 1-7 cover canonical routes, brand assets, typography, fixtures, status and provenance, charts, action states, motion, accessibility, documentation, TDD, and live verification.
- No placeholders: every task names exact files, commands, expected outcomes, and concrete APIs.
- Type consistency: fixture provider exports `EvidenceReportV1`, `PolicyV1`, and `PreparedActionV1`; action reducer owns UI state only; no browser import reaches `@tr4ce/evidence`.
