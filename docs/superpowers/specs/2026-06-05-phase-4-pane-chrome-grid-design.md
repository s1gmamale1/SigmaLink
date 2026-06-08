# Phase 4 — Pane chrome + grid (BridgeSpace-faithful) — Design Spec

**Date:** 2026-06-05 · **Status:** approved (design) → ready for `writing-plans`
**ROADMAP:** `docs/03-plan/ROADMAP.md` → "Phase 4 — Pane chrome + grid (mirror BridgeSpace)"
**WISHLIST items:** DEV-L1, DEV-L2, BSP-F1, BSP-F2, BSP-P2, BSP-P3

## Goal

Pane headers become a faithful BridgeSpace copy — a clean truncated title-pill + icon-only
glyph cluster, with the current "dot-soup" (~12 affordances) relocated off the bar. The pane
grid preserves user-set proportions across add/remove, persists them per-workspace, and reflows
with a reduced-motion-gated animation instead of hard-resetting.

## Operator decisions (locked 2026-06-05)

1. **Reference frames** — proceed from the existing day-185 review + screenshots
   (`docs/02-research/bridgespace-day185-2026-05-31/REVIEW.md`); no fresh D187/D188 capture.
   The §1.2 header description ("title + icon cluster: settings-gear, expand/focus, split-layout,
   minimize, close; metadata overload gone, model-tier string only in the pane BODY at idle") and
   §1.7 (amber single-accent focus border) are the authoritative reference.
2. **Header style** — **Full BridgeSpace strip.** Truncated title pill + icon-only cluster
   (gear · focus · split · minimise · close). ALL metadata leaves the bar → gear popover (grid
   view) + focus sidebar (fullscreen) + idle body splash. One always-visible **single status
   glyph** is retained on the pill (minimal signal; operator may later pin ±uncommitted too).
3. **Grid stickiness** — **Full:** preserve fractions across add/remove + persist per-workspace
   (KV) + reduced-motion-gated reflow animation.

## Current state (verified against code)

- `command-room/PaneHeader.tsx` (743 LOC): one `h-7` strip holding drag-grip, 3 status dots
  (session `dotColor` · Ruflo-health `rufloHealthDotClass` · FEAT-7 agent-accent + short-id),
  `PROVIDER·N` relabel dropdown + FEAT-11 rewind popover anchor, branch + model + ±uncommitted
  badge + `GitActivityStrip` + FEAT-3 usage-coins popover, then fullscreen / split-V / split-H /
  minimise / brief / close. Density-aware (`h-6` at `[data-grid-density=dense]`).
- `command-room/GridLayout.tsx` (398 LOC): CSS-grid. `colFracs`/`rowFracs` are **component-local
  `useState`**; **lines 92-93 hard-reset** them to `Array(n).fill(1)` whenever `cols`/`rows`
  change (shape change on add/remove) → user resize is lost. Pointer + keyboard divider drag with
  rAF-coalesce already exist. **No `workspaceId` is threaded in** → zero persistence today.
- `command-room/PaneFooter.tsx` (193 LOC): already ships the dim status line — ANIM-3 verb+elapsed
  (left) and `auto mode on (shift+tab to cycle)` / `bypass permissions on` (right). **BSP-F2 is
  effectively done** → minimal extend only.
- `command-room/PaneShell.tsx` (548 LOC): mounts `PaneHeader`, body, `PaneFooter`, and a
  `PaneContextSidebar` that opens on `isFullscreen` (FEAT-2). The integration seam for all of this.
- `command-room/PaneContextSidebar.tsx` (264 LOC): renders on fullscreen only; has **MCP/Ruflo +
  Usage** sections already. Natural home for displaced metadata.
- `command-room/PaneSplash.tsx` (138 LOC): idle pane body — home for the "model-tier at idle".
- `renderer/lib/workspace-color.ts`: `agentColor(id)` + `agentShortId(id)` exist; **no human-name
  alias system** (BSP-P3 alias is net-new — a small deterministic helper).
- `renderer/features/editor/EditorTab.tsx:93`: "stateful sidebar width with KV persistence" — the
  reuse pattern for DEV-L2 (kv.get on mount → apply; kv.set on change).
- `command-room/CommandRoom.tsx:58-59`: `activeWorkspaceId` is in scope; `GridLayout<SessionCell>`
  rendered at ~:458. Threading `workspaceId` for persistence is trivial.

## Design

### Deliverable A — Header redesign (DEV-L1 + BSP-F1/P2/P3)

New bar layout:

```
[●status • alias · effort]  …………  [⚙ gear] [⤢ focus] [⊞ split] [– minimise] [✕ close]
```

**Affordance relocation map** (nothing is dropped):

| Current header item | New home |
|---|---|
| session status dot + Ruflo-health dot + agent-accent dot | **fold → ONE status glyph** on the title pill (accent tints the pill). Ruflo *detail* → gear popover + sidebar |
| `PROVIDER·N` label + relabel dropdown | pill shows **alias · effort** (BSP-P3); `PROVIDER·N` + cwd → pill tooltip; relabel action → gear popover |
| FEAT-11 rewind, C-5 brief | gear popover |
| branch (BSP-P2), model, ±uncommitted, `GitActivityStrip` (FEAT-8), usage-coins (FEAT-3) | **off-bar** → gear popover (grid) + focus sidebar (fullscreen) + idle body splash |
| split-V **+** split-H (two icons) | **merge → one split icon** with a direction+provider submenu (keep `onSplit(direction, providerId)` contract) |
| drag-grip (FEAT-12 context inject) | merged into the **title pill** (pill is the drag handle via `handleGripDragStart` + `PANE_DRAG_MIME`); grip glyph shown on hover. Keep the FEAT-12 coachmark on the pill. |
| fullscreen/focus · minimise · close | **stay** as cluster icons (unchanged handlers) |

- **Gear popover** = consolidated metadata + actions panel: Identity (alias · `PROVIDER·N` ·
  agent-id · relabel) · Branch + worktree · Model + effort · Usage/cost · Git-activity ·
  ±uncommitted · Ruflo health · Rewind · Brief. The grid-view "everything that was on the bar"
  home, one click away. **NOT** BridgeSpace's 4-tab Settings/Status/Config/Stats inspector
  (out of scope — Phase 9/10).
- **`PaneContextSidebar`** (fullscreen) gains Identity / Branch / Model+Effort sections alongside
  its existing MCP + Usage. Same data the gear popover shows.
- **`PaneSplash`** idle body adds a quiet model-tier + cwd line (BridgeSpace "body-at-idle").
- **BSP-F1** single-accent amber focus ring already exists (`sl-pane-active` + `--ring` in
  `GridLayout.tsx:288`) — keep as-is (no elevation). The retained status glyph satisfies DEV-L1's
  "fold the 3 dots into one status glyph".
- **New helper** `agentAlias(id: string): string` in `workspace-color.ts` — deterministic
  human name (Thea/Ava/Nova/…) from a fixed list hashed by `session.id`, mirroring `agentShortId`.
  Effort tier from the existing `defaultModelFor(providerId).defaultEffort`.

**Tradeoff (accepted):** with metadata off-bar, branch/±uncommitted are not glanceable while a
pane runs in a grid — they are one click into the gear popover (or visible on fullscreen/idle).
The single status glyph (running/exited/error) stays pinned. Operator may later request ±uncommitted
stay pinned; left as a follow-up flag, not built now.

### Deliverable B — Grid stickiness (DEV-L2)

`GridLayout.tsx` + `CommandRoom.tsx`:

1. **Proportion-preserving reflow** — replace the `:92-93` hard reset. On shape change, rescale
   the existing fraction array to the new length: keep the leading min(old,new) fractions
   (renormalised) and seed any new tracks at the average, instead of `Array(n).fill(1)`. Net: a
   user's column/row proportions survive add/remove.
2. **Per-workspace persistence** — thread `activeWorkspaceId` (CommandRoom:59) into `GridLayout`
   as a new prop. Load persisted fracs from KV on mount/shape-change; debounced `kv.set` on
   divider release (reuse the `EditorTab.tsx:93` pattern). Key shape:
   `grid.fracs.<workspaceId>.<count>` (per pane-count so each layout remembers its own splits).
   Keep an in-memory fallback when `workspaceId` is null (split sub-grids, tests).
3. **Animated reflow** — add a `transition` on `grid-template-columns`/`grid-template-rows`,
   suppressed under `prefers-reduced-motion` (use the existing `prefersReducedMotion()` /
   `motion` helper, not a raw media query in JS where a CSS gate suffices). Must NOT animate
   during active pointer drag (the `document.body.dataset.dragging` flag already exists — gate on it).

### Deliverable C — Footer (BSP-F2)

`PaneFooter.tsx`: the dim per-pane status line already exists (ANIM-3). **Minimal extend** —
verify it reads clean beneath the stripped header; only adjust spacing/tone if the visual balance
shifts. No rebuild.

## Scope boundaries (YAGNI)

- **No** per-pane 4-tab Settings/Status/Config/Stats inspector (BridgeSpace §1.4) — gear opens a
  popover, not a tabbed inspector.
- **No** centered focused-pane modal (BridgeSpace §1.3) — reuse the existing inline
  `PaneContextSidebar` on fullscreen.
- **No** theme-token redefinition (Phase 5's job).
- **No** Canvas / freeform panes (BSP-P4 — deferred).
- **No** changes to split-group sub-layout math, terminal cache, or PTY wiring.

## Test plan

- `PaneHeader.test.tsx` — **lockstep rewrite.** Assertions that query `pane-provider-label`,
  `agent-short-id`, `ruflo-health-dot`, inline branch/model, usage-coins, the two split icons,
  etc. move to: (a) the title pill (alias/status/drag), (b) the gear popover (relabel/rewind/brief/
  metadata), (c) the merged split menu. Preserve stable `data-testid`/`aria-label`s where the
  affordance survives; add new ones (`pane-gear`, `pane-title-pill`, `pane-gear-popover`).
- `GridLayout.test.tsx` — **lockstep.** Add: fractions survive a shape change (add/remove);
  KV load/save called with the right key; reflow transition present and suppressed under
  reduced-motion + during drag. Keep existing divider-drag/keyboard-resize assertions.
- `PaneContextSidebar.test.tsx` — extend for the new Identity/Branch/Model sections.
- `PaneFooter.test.tsx` — confirm unchanged behavior (regression guard).
- New: `agentAlias` unit test (deterministic, stable per id, within the name list).
- Gate: `tsc -b` · vitest · lint · build · full `tests/e2e/` (per the release-gate memory —
  whole `tests/e2e/` dir, not just smoke). Re-gate in MAIN after lane merge (worktree tsc is laxer).

## Risks

- **Test churn is the bulk of the work** — moving affordances off the bar breaks many PaneHeader
  assertions. Budget for it; update in lockstep, don't delete coverage.
- **Sibling-twin drift** — the split path and any mirrored read sites: change all twins (grep
  before edit). The gear popover and the focus sidebar render the SAME metadata from the same
  source — factor a shared `PaneMeta` data hook/component so they can't drift.
- **KV persistence keying** — per-`(workspaceId,count)` must respect a null workspaceId (sub-grids)
  without throwing; honor the global boot reader pattern; debounce writes (divider drag fires fast).
- **Reduced-motion** — the reflow transition must be genuinely suppressed (CSS gate), verified by
  the e2e/visual pass, not just unit-mocked.
- **Worktree isolation** — lanes are code-editing → `isolation:"worktree"` on the Agent call;
  FF-align each lane to a shared foundation SHA; remove stale worktrees post-merge. (There are
  already stale `.claude/worktrees/agent-*` dirs — do not write into them.)

## Execution shape (for `writing-plans` → subagent lanes)

Three file-disjoint lanes, worktree-isolated; lead owns the integration seam:

- **Lane A — header.** `PaneHeader.tsx` (rewrite to pill+cluster), new `PaneGearPopover.tsx` +
  shared `PaneMeta` data, `PaneContextSidebar.tsx` (extend), `PaneSplash.tsx` (idle meta line),
  `workspace-color.ts` (`agentAlias`), `PaneHeader.test.tsx` + `PaneContextSidebar.test.tsx`.
- **Lane B — grid.** `GridLayout.tsx` (preserve+persist+animate) + `GridLayout.test.tsx`.
- **Lane C — footer + sweep.** `PaneFooter.tsx` extend + `PaneFooter.test.tsx`; test-selector
  sweep across `command-room/*` for any now-moved `data-testid`s.
- **Lead seam.** `PaneShell.tsx` (wire gear popover open-state if lifted; pass new props) +
  `CommandRoom.tsx` (thread `activeWorkspaceId` → `GridLayout`). Final re-gate in main.

## Definition of done (from ROADMAP, made concrete)

- Pane header matches the BridgeSpace reference: truncated title pill + icon-only cluster
  (gear · focus · split · minimise · close); no dot-soup; all metadata reachable via gear popover
  / focus sidebar / idle splash; single status glyph + amber focus ring intact.
- Adding/removing a pane preserves column/row proportions; they persist per-workspace across
  app restart; reflow animates and is reduced-motion-safe and drag-safe.
- Footer reads clean; alias + effort show on the pill (BSP-P3); branch reachable (BSP-P2).
- `tsc -b` · vitest · lint · build · full `tests/e2e/` green; PaneHeader/GridLayout tests updated
  in lockstep, coverage not reduced.
