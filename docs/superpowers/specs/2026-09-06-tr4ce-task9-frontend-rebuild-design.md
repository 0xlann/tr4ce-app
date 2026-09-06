# TR4CE Task 9 Frontend Rebuild Design

## Goal

Replace the mock-only web prototype with the evidence-first Task 9 product surface. The redesign must make policy verdicts, uncertainty, provenance, and wallet authority clearer than return, while giving TR4CE an original editorial-operational identity.

## Scope and branch boundary

`frontend-polish` is fast-forwarded through `origin/dev` commit `30c2b20`, which completes Task 4 in `@tr4ce/evidence`. The rebuild does not modify the evidence engine, database, Substreams package, MCP tools, wallet integration, or API behavior.

Task 5 policy evaluation and Task 6 HTTP endpoints are not implemented. The browser therefore renders deterministic, clearly labeled illustrative fixtures shaped as domain response contracts. It must not import `@tr4ce/evidence` into client code or calculate evidence in the browser. When Task 6 exists, a single fixture-provider module is replaced with HTTP reads; components and routes remain unchanged.

## Canonical routes

The existing Task 9 file map is authoritative:

- `/`: editorial orientation and interactive policy-to-verdict demonstration.
- `/search`: curated comparison plus one-address diagnostics.
- `/reports/[id]`: immutable evidence dossier and provenance disclosure.
- `/actions/[id]`: prepared action, simulation, wallet handoff, and invalidation states.
- `/evals`: fixed agent-evaluation evidence surface.

No `/compare`, `/check`, or singular `/report` aliases are created. The current reducer-only screen swapping is removed.

## Brand and visual system

### Thesis

Evidence printed like a botanical specimen sheet: cream paper, deep-green ink, mechanical labels, and one branching provenance trace linking each verdict to its source block.

### Canonical logo assets

- `apps/web/public/icon-logo.png`: compact icon, splash, favicon source, mobile navigation.
- `apps/web/public/text-logo.png`: wordmark, desktop navigation, footer.
- The old construction-sheet `tr4ce-logo.png` is not used in visible UI.

No logo is redrawn, recolored, cropped, stretched, or shadowed.

### Tokens and typography

- Canvas: `#FDF3E5`; paper: `#FFFFFF`; primary ink: `#101814`; primary green: `#035535`.
- Keep semantic colors distinct from brand green: pass `#137A45`, fail `#B42318`, unknown `#6B5AA6`, warning `#A15C00`, provenance `#2563EB`.
- Load Space Grotesk for display, Inter for UI/body, and IBM Plex Mono for evidence through `next/font` with self-hosted output.
- Evidence values use tabular numerals. Every displayed amount includes a unit.
- Home sections use 128px vertical rhythm on desktop and 80px on mobile. Operational surfaces use 48px.
- Static cards have 1px borders and no shadow. Drawers and wallet confirmations are the sole elevated surfaces.

### Copy constraint

No em dash character appears in shipped site content, metadata, labels, empty states, or buttons. Use sentences, commas, parentheses, or colons instead. Prohibited language remains: safe, guaranteed yield, risk-free, AI verified, best vault without a named policy and metric, and realized APY.

## Experience

### Home

The hero is the proof object. It contains a policy preset control and three outcome rows. Switching `Strict`, `Balanced`, and `Lenient` updates visible PASS, FAIL, and UNKNOWN verdicts against illustrative vault fixtures at a named illustrative block. It does not animate money or imply live data.

Subsequent sections are: manifesto, provenance trace, report specimen, PASS/FAIL/UNKNOWN explainer, action-preview stage, limitation callout, and footer. All demonstrate real route components rather than invented screenshots or testimonials.

### Search

A typed five-rule policy remains visible while results are read. Desktop uses a semantic comparison table at 960px and up. Narrow layouts use one complete vault card per result. Results order is status, data completeness, then name. UNKNOWN cannot outrank PASS.

### Report

Order is fixed: identity and as-of context, policy verdict, observed share-value return and TVL, account withdrawal evidence, net flows/history coverage, formula/raw values/provenance, limitations, then action. Required evidence never lives only in a tooltip.

### Action

The visible path is Prepared, Simulated, Wallet confirmed. Simulation failure, expired simulation, changed wallet context, wallet rejection, pending, confirmed, reverted, and receipt reconciliation failure are distinct states. No call to action claims execution is safe.

## Component seams

- `ui`: logo lockup, section heading, status stamp, provenance chip/drawer, data banner, limitation callout, block ruler.
- `policy`: policy panel and policy preset controls.
- `evidence`: vault table/card, evidence card, share-value chart, flow bars, report dossier, trace diagram.
- `actions`: action stepper and exact action preview.
- `home`: hero instrument and editorial composition sections.
- `data`: a single illustrative fixture provider that returns domain-shaped report and policy data.

`StatusStamp` always includes icon, visible label, and reason text. `UNKNOWN` never displays a zero substitute.

## Motion

CSS handles hover, focus, disclosure, stamp, row, and state transitions. GSAP plus `@gsap/react` is allowed only for the hero word reveal, manifesto reveal, and one provenance SVG draw sequence. All JS animation is client-only, scoped to a React ref, cleaned up on unmount, and guarded through `gsap.matchMedia()` for reduced motion.

No animated financial counters, looping decoration, parallax, cursor follower, or layout-property animation is allowed. Motion runs through transform and opacity only. Hover/disclosure transitions are 120-180ms; drawers are 200-240ms.

## Accessibility and performance

- WCAG 2.2 AA text and control contrast.
- `:focus-visible` applies to every interactive control with a 2px brand-500 outline and 2px offset.
- Touch targets are at least 44px.
- All drawers trap focus, close on Escape, and restore the trigger focus.
- Evidence refresh uses `aria-live="polite"`; action-blocking errors use `assertive`.
- Charts have title, description, and table alternative; gaps remain gaps; values are never smoothed.
- No external font CSS, photo dependency, icon library, chart dependency, or browser-side evidence arithmetic.
- GSAP loads only in client interaction leaves. The home hero remains meaningful before motion initializes.

## Tests and verification

Tests precede every new data/state function. Behavior tests cover policy preset outcome changes, status ordering, UNKNOWN rendering, action invalidation, and report fixture integrity. UI verification uses the running Next app: desktop and 390px mobile, keyboard-only navigation, reduced-motion mode, unknown evidence, failed simulation, and route deep links.

## Completion criteria

- The old `PrototypeApp` screen-switcher is removed.
- All canonical Task 9 routes render.
- New logo assets are used without construction guides.
- The design-system document reflects the implemented system.
- No shipped UI copy contains an em dash.
- No web component imports the evidence engine.
- The interface remains credible with no wallet and illustrative or partial data.
