# BridgeSpace-style BSP Pane Tiling — Design

**Date:** 2026-06-09
**Status:** Approved (design) — pending spec review
**Topic:** Replace the rigid pane grid with a BridgeSpace-style binary-space-partition (BSP) tiling layout.
**Supersedes:** the fixed-grid feel tracked as wishlist **DEV-L2**. Distinct from the deferred freeform **BSP-P4** Canvas.

## 1. Problem

SigmaLink's Command Room lays panes out with `GridLayout` — a CSS grid whose shape
is computed from the pane **count** (`shapeFor`: 1→1×1, 3-4→2×2, …). Two consequences
the operator wants gone:

1. **Dead space.** 3 panes → a 2×2 grid with the 4th cell empty (2 on top, 1
   bottom-left, bottom-right blank). The grid never fills the viewport at
   non-perfect-square counts.
2. **Whole-row/column resize.** Dragging a divider moves an entire column or row
   boundary across all rows/cols — you cannot size one pane independently.

Plus cosmetics: rounded corners on tiles (`rounded-lg`/`rounded-md`).

Target = BridgeSpace: panes tile to **fill all space**, each pane is **independently
sized** by dragging the border between it and its neighbor (neighbors-only),
**square corners**, thin dividers, minimal chrome.

> **Reference note.** Repo teardown notes (BridgeSpace v3.0.x, Day 181–185) describe a
> *uniform grid with no drag-resize*. The operator's live screenshot (v3.1.x) and explicit
> requirements describe **independent BSP tiling**. This design follows the operator's
> intent (independent tiling), confirmed by three product answers: replace the grid ·
> start 1 pane + split to add · auto-split the focused pane by aspect.

## 2. Goals / Non-goals

**Goals**
- Replace `GridLayout` with a BSP tiling engine: a per-workspace tree of H/V splits, leaves = sessions.
- Panes always fill 100% of the body — no empty cells.
- Dragging a split divider resizes **only the two adjacent panes**.
- Add a pane → auto-split the focused leaf along its longer axis; explicit split-right/down still available.
- Close a pane → its sibling expands to reclaim the space (collapse the split).
- Square corners, 1px hairline dividers (double as the drag handle), accent focus ring on the active pane.
- Persist the tree per-workspace; restore on reload; self-heal against the live session set.
- Keep terminals intact across every layout change (no xterm remount/reflash).

**Non-goals (deferred → wishlist)**
- Drag-a-pane-to-a-new-position rearrange (react-mosaic gives this free; custom needs ~100 LOC). Deferred.
- Launcher-wizard rework. The launcher keeps spawning N panes; the engine **auto-tiles** them. A later pass can simplify the wizard to "start with 1."
- Freeform/overlapping Canvas mode (BSP-P4) — separate, still deferred.
- Lossy migration of old `grid.fracs.*` proportions into the tree (not structurally compatible; fresh start).

## 3. Engine choice

**Custom BSP tree** (no new dependency). Rationale (from research):
- The resize drag-math already exists twice (`GridLayout.startDrag`, `SplitGroupCell.startSubDrag`) — the engine generalizes both into one recursive component.
- `terminal-cache` (`attachToHost`/`detachFromHost`, keyed by `sessionId`) is already layout-agnostic and remount-safe.
- The KV-persistence pattern (`rpc.kv.get/set`, debounced) maps directly to one serialized tree blob.
- No beta-stability risk (react-mosaic v7/React-19 is beta).
- `react-resizable-panels` (already shipped) is unsuitable: it breaks when the panel tree is restructured at runtime (issues #372/#314).

## 4. Data model

```ts
// shared/bsp-layout.ts  (new, pure, no React/DOM/IPC — unit-testable)
export type BspNode =
  | { type: 'leaf'; sessionId: string }
  | { type: 'split'; dir: 'h' | 'v'; ratio: number; a: BspNode; b: BspNode };
//  dir:'v' = vertical divider → a=left, b=right
//  dir:'h' = horizontal divider → a=top,  b=bottom
//  ratio   = fraction (0..1) of the parent allocated to child `a`; b gets 1-ratio
export type BspTree = BspNode | null; // null = no panes
```

**Pure operations** (all return new trees; never mutate):
- `splitLeaf(tree, targetId, newId, dir, ratio=0.5)` — replace the `targetId` leaf with a split of `{a:target, b:newLeaf}`.
- `removeLeaf(tree, sessionId)` — drop the leaf and collapse its parent split into the surviving sibling.
- `setRatio(tree, path, ratio)` — update one split node's ratio (path = address of the node).
- `leafIds(tree)` — ordered list of session ids in the tree.
- `balancedTree(ids)` — build a balanced H/V-alternating tree from a list (for auto-tiling N un-placed sessions; mirrors `shapeFor`'s intent but as a tree).
- `reconcile(tree, liveIds, focusId)` — **the heart**: drop leaves whose session is gone (collapse), insert sessions not yet in the tree next to `focusId` (auto-split by aspect — but aspect needs DOM; see §6), return a tree whose leaves == `liveIds` exactly. Deterministic, side-effect free.

`MIN_RATIO = 0.1` clamp (a pane can't be dragged below 10% of its split).

## 5. Persistence

- KV key: `bsp.tree.<workspaceId>` → `JSON.stringify(tree)`.
- Load on workspace activate; debounce-save (250ms, matching the current grid) after a resize drag ends or after a structural change (split/close).
- The **session list is authoritative**; the tree is reconciled against it on every render
  (`reconcile`). So a corrupt/stale tree can never strand a session or show a ghost —
  worst case the layout re-derives to a balanced tree. (Same self-healing philosophy as
  `reconcileOpenWorkspaces`.)
- Old `grid.fracs.*` keys: left in place, never read. No migration.

## 6. Components & rendering

```
CommandRoom
 └─ BspLayout (NEW — replaces GridLayout)            // owns tree state + KV + reconcile + keyboard
     └─ BspBranch (recursive)                        // a split node: flex row/col + Divider + 2 children
         ├─ BspBranch | BspLeaf
         ├─ Divider (NEW)                             // 1px hairline, ~6px hit-area, drag + arrow-key resize
         └─ BspBranch | BspLeaf
             └─ renderLeaf(sessionId) → PaneShell ... // unchanged; key = sessionId
```

- **`BspLayout`** (`features/command-room/BspLayout.tsx`): props mirror what `CommandRoom`
  already passes (`sessions`, `activeSessionId`, `focusedPaneId`, `renderLeaf`, `workspaceId`,
  `onActivate`). Holds the tree (`useState`, seeded from KV), runs `reconcile(tree, sessionIds, activeId)`
  in a memo, persists on change. Fullscreen (`focusedPaneId`) renders only that leaf at 100%
  (others `display:none`, stay mounted — preserves the terminal-cache contract exactly like today).
- **`BspBranch`**: `display:flex; flex-direction: row (v) | column (h)`. Child A `style={{flex: ratio}}`,
  child B `style={{flex: 1-ratio}}`, both `min-w-0 min-h-0`. The `Divider` sits between them.
- **`BspLeaf`**: a `min-w-0 min-h-0 overflow-hidden` square-cornered box that calls `renderLeaf(sessionId)`.
  Focus ring (`sl-pane-active` + `--ring`) when active and not fullscreen. **No `rounded-*`.**
- **`Divider`**: 1px line using border color; a wider transparent hit-area (`±3px`); `cursor-col-resize`/`row-resize`;
  pointer-drag updates the owning split's ratio (rAF-coalesced; sets `document.body.dataset.dragging='true'`
  so `Terminal.tsx` relaxes its refit debounce — preserve this); `role="separator"`, `aria-orientation`,
  `tabIndex=0`, Arrow-key nudge (2%) — ported from `GridLayout`.

**Auto-split direction by aspect:** decided when a new leaf is inserted next to the focused leaf.
The focused leaf's host element measures its `getBoundingClientRect()`; `width >= height` → vertical
split (left/right), else horizontal (top/bottom). Because this needs a live measurement, `reconcile`'s
insertion uses a direction hint supplied by `BspLayout` (which reads the focused leaf's rect via a ref map);
if no rect is available (e.g. headless reconcile on load), fall back to `balancedTree` placement.

**Terminal safety (critical invariant):** every leaf is keyed by `sessionId` for its entire life. Splits/
resizes/closes restructure ancestor nodes but never change a surviving leaf's key, so React reconciles
leaves in place — `SessionTerminal` never unmounts, the cached xterm keeps its scrollback, and the
per-mount `ResizeObserver` issues the refit on size change exactly as today. No `terminal-cache` changes.

## 7. Behavior details

| Action | Result |
|---|---|
| Launch workspace (N panes from launcher) | `reconcile` auto-tiles the N sessions into a `balancedTree` (fills space). |
| +Pane / new session arrives | inserted as a split of the focused leaf, dir by aspect; sibling shrinks to make room. |
| Split-right / split-down (context menu) | explicit dir; same insert. Keeps `rpc.swarms.splitPane` (shared-worktree) — it just lands a leaf. |
| Close pane | `removeLeaf` → parent split collapses → sibling expands to fill. |
| Drag divider | only that split's `ratio` changes → only the two adjacent subtrees resize. |
| Fullscreen a pane | that leaf renders 100%; others `display:none` (mounted). |
| Reduced motion | no flex/transition animation on resize/reflow (respect `prefers-reduced-motion`). |
| Workspace switch | snap (suppress transition) like today; reconcile from that workspace's KV tree. |

The existing `AgentSession.splitGroupId/splitDirection/splitIndex` DB columns are no longer the
layout source of truth (the tree is). They are retained for the shared-worktree split semantic and to
avoid a migration; the layout ignores them. (A later cleanup can deprecate them.)

## 8. Styling (BridgeSpace match)

- **Corners:** remove `rounded-lg` (`GridLayout.tsx:378`) and `rounded-md` (`SplitGroupCell.tsx:111`); leaves are square. (PaneShell root has no radius already.)
- **Dividers:** 1px `border`/`hsl(var(--border))` hairline; no gutter (panes share edges → max fill).
- **Focus:** keep the accent ring (`shadow-[0_0_0_1px_hsl(var(--ring))]` / `sl-pane-active`) on the active, non-fullscreen leaf.
- **Density:** keep the existing comfortable/compact/dense font-scale tiers keyed off leaf count.

## 9. Testing

- **`shared/bsp-layout.test.ts`** (new, pure): `splitLeaf`, `removeLeaf` (+collapse), `setRatio` clamp, `balancedTree`, `reconcile` (drop-missing, insert-new-by-focus, fill-from-empty, idempotent when in sync, never strands a live session, never keeps a dead leaf).
- **`BspLayout.test.tsx`** (new, jsdom): renders leaves for each session; divider drag updates ratio (use `createEvent`+`defineProperty(clientX/Y)` + stubbed rects, per the workspace-reorder test learnings); close collapses; fullscreen shows one leaf; KV load/save mocked.
- **Rewrite `GridLayout.test.tsx`** → delete or port relevant cases to `BspLayout`.
- **Rewrite `e2e/pane-split.spec.ts`** to BSP semantics (assert fill + independent resize + square corners; replace the `[data-split-group]` assertion).
- Gate in MAIN: `tsc -b` · `eslint --max-warnings 0` · `vitest run` · `product:check`. e2e via CI e2e-matrix (no local Electron launch).

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Terminal remount/reflash on relayout | Leaf key = sessionId for life; never unmount on split/resize/close. Covered by an explicit test + manual smoke. |
| Tree/session desync (crash, resume, bulk spawn) | `reconcile` runs every render; session list authoritative; balanced fallback. |
| Old grid frac KV keys | Ignored; no migration; documented. |
| Auto-split needs a live rect | Direction hint from focused-leaf ref; `balancedTree` fallback when headless. |
| Scope creep into launcher | Out of scope; auto-tile keeps N-spawn working. |

## 11. File-level change summary

- **New:** `shared/bsp-layout.ts` (+ test), `features/command-room/BspLayout.tsx` (+ test), `features/command-room/BspDivider.tsx`.
- **Change:** `CommandRoom.tsx` (swap `GridLayout`→`BspLayout`, drop `groupSessionsIntoCells` flat-cell pipeline), remove rounded-corner classes.
- **Remove/retire:** `GridLayout.tsx`, `SplitGroupCell.tsx` (logic absorbed by the tree), `GridLayout.test.tsx` (ported).
- **Reuse untouched:** `PaneShell.tsx`, `Terminal.tsx`/`terminal-cache.ts`, `grid-fracs.ts` (`reshapeFracs` reused for node sizing), `rpc.swarms.splitPane`/`minimisePane`, the split DB columns.
