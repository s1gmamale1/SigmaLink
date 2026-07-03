# Minimal Chrome — BridgeMind-style launcher landing, brand titlebar, sidebar polish

**Date:** 2026-07-02 · **Branch:** `feat/minimal-chrome` (off origin/main @ 5681f5e, v2.9.0)
**Reference:** operator screenshot of BridgeMind v3.4.6 launcher (structure only, NOT pixels — #211 lesson)

## Goal

Match the minimalistic structure of BridgeMind's launcher screen across four SigmaLink
surfaces, adapted to SigmaLink's existing theme-token system (all 15 themes). Renderer-only;
zero main-process / RPC / launch-contract changes.

## Approved decisions (operator)

1. Scope = all four surfaces: launcher hero page, titlebar, sidebar, kbd-hint footer.
2. Launcher step 1 = **pure landing** (hero + stacked mode rows only; folder step slides in
   after a row is clicked).
3. Titlebar = **brand bar**: rooms-menu button · Σ + "SigmaLink" wordmark + muted version.
   Workspace/user text dropped. Right icon cluster stays.
4. Sidebar keeps the **Σ-click collapse/expand** affordance.

## A — Launcher landing (`workspace-launcher`)

- New `StepId 'intent'` prepended to every mode's step list in `modes.ts`
  (`space: ['intent','start','layout','agents','sessions']`, others: `['intent','start']`).
  `stepAfterStart` unchanged. Launch RPCs unchanged.
- Launcher opens on `'intent'`. The **Stepper chrome is hidden** on the intent step (pure
  landing); it renders from `'start'` onward. Back from `'start'` returns to the landing.
- New `LauncherLanding.tsx` (replaces `IntentCards.tsx`, which is deleted):
  - Centered column: `Monogram` Σ + `SigmaLink` wordmark → display-size tagline
    **"Command the fleet."** in `text-primary` (per-theme tint) → muted
    "Choose how you want to work."
  - 4 stacked full-width rows (icon tile + name + kbd label, **no blurbs** — blurb text
    moves to `title` tooltip):
    | Row | mode | kbd label |
    |---|---|---|
    | SigmaLink | `space` | ⌘T |
    | SigmaSwarm | `swarm` | ⌘S |
    | Single terminal | `single` | ⌘1 |
    | SigmaCanvas (+ALPHA chip, `canvas.gaSign` gate preserved) | `canvas` | ⌘2 |
  - Row styling: rounded-xl, `border-border bg-card/40`, hover lift (GPU transform only),
    1px top gradient hairline from theme tokens (`from-primary/25 via-accent/20`).
  - Clicking a row: `onChange(mode)` + advance to `'start'` (folder step).
  - kbd labels are **labels only** (no new bindings — parked on WISHLIST).
- `Launcher.tsx`: step state starts at `'intent'`; row click = set mode + goto `'start'`.

## B — Titlebar (`top-bar/Breadcrumb.tsx`, slimmed in place)

- Left: `RoomsMenuButton` · Σ `Monogram` (~14px) · `SigmaLink` (text-xs font-medium) ·
  muted version from `rpc.app.getVersion()` (fetched once, cached in state; empty until
  resolved — no layout shift, reserve no width).
- **Dropped:** `Workspace N / user — name` text, `extractUserFromPath`, the `app.userName`
  kv plumbing (dead code removed).
- Right cluster unchanged in function, tightened in spacing: `NotificationBell` ·
  memory-graph button (keeps `noDragStyle()`) · `RightRailSwitcher` · `RufloReadinessPill`.
- Preserved invariants: `h-8`, `dragStyle()` drag region, `WIN32_WCO_RESERVE_PX`,
  `sl-glass-toolbar`, `data-testid="breadcrumb"` (+ `breadcrumb-empty` variant retired —
  empty and active states now render the same bar; keep ONE testid).

## C — Sidebar (small delta — v2.9.0 already has pills + attention glow)

- `Sidebar.tsx` header: keep Σ `Monogram` button (click = collapse/expand) + collapse
  chevron; **drop the `SIGMALINK` wordmark text** (brand moved to titlebar).
- `WorkspacesPanel.tsx` header: `Workspaces` micro-header gains a muted count
  (`Workspaces  4` — count = open workspaces). Existing `+` / chevron menus, pane-count
  pill, attention glow, row colors, drag-reorder all unchanged.

## D — Kbd-hint footer (launcher landing only)

- Thin muted strip pinned to the bottom of the landing:
  `⌘K · Command palette   ⌘O · Memory   ⌘, · Settings`.
- Only hints whose bindings exist are shown (verify ⌘, at build time; drop any that don't).
- Uses a tiny shared `Kbd` presentational primitive (also used by landing rows).

## E — Theming rules

- Zero hardcoded colors. Tokens only: `bg-background/card`, `border-border`,
  `text-muted-foreground`, `text-primary`, `accent`. Must read cleanly on parchment
  (light) and the glass family (material auto-applies via card/toolbar tokens).
- Motion: `sl-fade-in` mount only + GPU hover lift; reduced-motion safe (existing
  global reset applies).

## F — Testing & verification

- Unit (jsdom + vi.hoisted mocks per renderer convention): `LauncherLanding.test.tsx`
  (rows render, click advances, ALPHA gate), `modes.test.ts` (intent step sequences),
  `Breadcrumb.test.tsx` rewrite (brand bar, version, no workspace text),
  `Sidebar`/`WorkspacesPanel` tests updated (no wordmark, header count).
- Local gate: `tsc -b` + `eslint .` (mandatory — PR #207 lesson) + full vitest + build.
  No local e2e; CI owns e2e.
- **Live-dial**: safe iso Electron launch (`--user-data-dir` temp); operator eyeballs one
  surface at a time (landing → titlebar → sidebar → footer) before the next lands.

## Out of scope (→ WISHLIST)

- Real key bindings for the landing rows (⌘T/⌘S/⌘1/⌘2).
- Attention-count numeric badge on sidebar rows (glow already exists).
- Version-click → "What's new" affordance in the titlebar.
- Any Command-Room / pane-chrome changes.
