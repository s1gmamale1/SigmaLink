# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.
>
> **Cleared 2026-07-27 at the operator's request.** The previous tracked contents remain
> recoverable from Git history. This file now starts with the pane-reordering review below.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

---

## ✨ Future enhancements (planned-later upgrades)

- **[command-room] drag panes to exchange visual positions** — let the operator group related
  sessions (for example, Claude panes on the top row) without restarting panes or changing the
  fill-grid shape. Build after the reviewed invariants and regression matrix below are promoted
  into an implementation phase.

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

---

## 🔬 Deep review findings (2026-07-27) — safe Command Room pane reordering

_Status: reviewed and feasible; not implemented. Review performed on clean branch
`fix/pane-stale-render-esc-focus` at `80065c3`, using the supplied 11-pane screenshot, three
independent read-only audits, code/history tracing, and focused baseline tests. Promote this
section to ROADMAP before implementation._

### Outcome

Pane reordering can be added safely as a **workspace-scoped presentation-order overlay**. It must
not modify session identity, PTY ownership, database `pane_index`, grid-shape math, or persisted
resize fractions.

The recommended first release is **drop-on-pane swap**:

- Drag pane A's dedicated reorder grip over pane B.
- On drop, A and B exchange visual slots exactly once.
- The row/column geometry stays fixed; each moved pane inherits its destination slot's size.
- The active/focused/attention session IDs stay unchanged.
- No PTY spawn, kill, close, resize storm, or lifecycle RPC is part of reordering.

For heterogeneous layouts, swap is safer than insertion. With five panes (`[a,b,c] / [d,e]`),
swapping `e` with `b` moves only those two identities. Inserting `e` before `b` also shifts `b`,
`c`, and `d`, sending more panes across row parents and increasing remount risk. Explicit
before/after insertion can be a later enhancement after swap is dogfooded.

### Root cause — why panes cannot move today

- **No presentation-order model exists.** `CommandRoom` describes sessions as authoritative and
  the grid as their pure projection; it passes `sessions.map((s) => s.id)` directly to `PaneGrid`.
  `app/src/renderer/features/command-room/CommandRoom.tsx:30-34,441-456`.
- **The shape helper deliberately preserves incoming order.** `paneRows()` only slices the ordered
  list into deterministic rows, and its invariant test requires every ID exactly once in the same
  order. `app/src/shared/pane-grid-shape.ts:12-30`;
  `app/src/shared/pane-grid-shape.test.ts:41-46`.
- **PaneGrid has resize drag only.** Its API has no order state/callback, and the only drag lifecycle
  changes CSS grid fractions through `PaneDivider`.
  `app/src/renderer/features/command-room/PaneGrid.tsx:38-45,223-261,275-351`.
- **The apparent title “grip” is already a different feature.** It performs copy-style pane-context
  injection using `PANE_DRAG_MIME`; it is not a move handle.
  `app/src/renderer/features/command-room/PaneHeader.tsx:213-226,247-262`.
- **Runtime order is incidental.** `ADD_SESSIONS` upserts through a `Map`; existing IDs retain their
  insertion position and new IDs append. Cold hydration instead returns database rows ordered by
  `pane_index ASC`. `app/src/renderer/app/state.reducer.ts:455-465`;
  `app/src/main/rpc-router.ts:1863-1871,1900-1923`.

### Safety boundary — `pane_index` is not visual order

- `agent_sessions.pane_index` is a durable launcher/resume slot, not a cosmetic position.
  `app/src/main/core/db/schema.ts:62-67`.
- It participates in the status-aware unique index for live panes.
  `app/src/main/core/db/schema.ts:111-120`.
- Rank-then-filter hydration partitions historical rows by this slot to select one owner; changing
  it can unshadow stale rows or resume the wrong conversation.
  `app/src/main/rpc-router.ts:1905-1921`.
- New panes allocate the lowest free live slot, including gaps.
  `app/src/main/core/workspaces/pane-slots.ts:8-41`.

**Required rule:** never rewrite or swap database `pane_index` values for UI reordering. The domain
`sessions` array also remains untouched; only its Command Room projection changes.

### Known-good grid invariants to preserve

- **Shape:** approximately `round(sqrt(n))` rows, earlier rows fuller, short rows widened edge to
  edge; examples include 3 → `[2,1]`, 5 → `[3,2]`, 7 → `[3,2,2]`, 12 → `[4,4,4]`.
  `app/src/shared/pane-grid-shape.ts:12-30`;
  `app/src/shared/pane-grid-shape.test.ts:4-16`.
- **Geometry:** each row is an independent grid. Vertical dividers resize adjacent panes in that
  row only; horizontal dividers resize adjacent rows.
  `app/src/renderer/features/command-room/PaneGrid.tsx:1-9,275-352`.
- **Hot resize path:** CSS variables are mutated imperatively without React state per pointer frame;
  this prevents active-session rerenders from stomping a live resize.
  `app/src/renderer/features/command-room/PaneGrid.tsx:11-27,235-261`.
- **Persistence:** resize fractions live under `panegrid.<workspaceId>` and are keyed only by the
  row-count signature. A same-count reorder must retain these values unchanged.
  `app/src/renderer/features/command-room/PaneGrid.tsx:63-99,122-128,154-179,215-221`;
  `app/src/shared/pane-grid-shape.ts:33-37`.
- **Responsiveness:** tracks remain `minmax(0,Nfr)` and resize with the window without restoring
  intrinsic terminal widths. `app/src/renderer/features/command-room/PaneGrid.tsx:67-72`.
- **Focus and attention:** active, fullscreen, and attention state are keyed by session ID, not
  position. Reorder must not dispatch focus/attention changes.
  `app/src/renderer/app/state.types.ts:96-105,157-162`;
  `app/src/renderer/features/command-room/PaneGrid.tsx:295-345`.
- **Raster stability:** every pane keeps a non-auto stacking context and no focus transition.
  `app/src/renderer/features/command-room/PaneGrid.tsx:316-335`.
- **Fullscreen:** siblings remain mounted but hidden; entering/exiting fullscreen triggers one
  same-frame terminal refit. Reorder is disabled while fullscreen is active.
  `app/src/renderer/features/command-room/PaneGrid.tsx:195-210,296-345`.
- **Divider cleanup:** resize start/end pairing and mid-drag unmount cleanup remain independent of
  reorder. `app/src/renderer/features/command-room/PaneDivider.tsx:28-42,52-96`.

### Recommended V1 architecture

1. **Pure order helpers.** Add a small `app/src/shared/pane-order.ts` module with:
   `swapPaneIds`, `reconcilePaneOrder`, `replacePaneOrderId`, and `parsePaneOrder`. Keep ordering
   separate from `pane-grid-shape.ts`, whose only concern is row shape.
2. **Presentation state at the Command Room boundary.** A dedicated hook derives
   `orderedSessions` from canonical live sessions plus the saved ID order. Both PaneGrid IDs and
   displayed pane ordinals must use this same projection. Do not add a global reducer action that
   reorders domain sessions.
3. **Versioned, separate persistence.** Store a versioned ID list under
   `ui.<workspaceId>.commandRoom.paneOrder`, using the existing best-effort workspace UI helpers.
   Keep it separate from `panegrid.<workspaceId>` so resize and order writers cannot clobber one
   another. `app/src/renderer/lib/workspace-ui-kv.ts:10-46`.
4. **Lossless reconciliation.** Validate string IDs, de-duplicate, retain saved IDs that are still
   live, then append missing/new live IDs in canonical backend order. A stale or malformed record
   must never create, hide, duplicate, or resurrect a pane.
5. **Async-load guard.** Ignore stale workspace reads and do not persist until the current
   workspace's order load completes, mirroring the resize persistence guards.
   `app/src/renderer/features/command-room/PaneGrid.tsx:151-179,215-220`.
6. **Lifecycle replacement.** Normal boot resume reuses the same session row/ID.
   `app/src/main/core/pty/resume-launcher.ts:779-814`. The explicit crash-relaunch path creates a
   new ID and then removes the old one, so it must call `replacePaneOrderId(oldId, newId)` before
   removal to preserve the visual slot.
   `app/src/renderer/features/command-room/CommandRoom.tsx:281-311`.
7. **Commit once.** Do not live-reorder the React tree while hovering. Keep panes stationary, show
   a lightweight target overlay, and swap once on drop. Cross-row moves can remount PaneShell
   because session keys are scoped inside row parents; terminal instances and scrollback survive
   through the session-keyed cache, but PaneShell-local state can reset.
   `app/src/renderer/features/command-room/PaneGrid.tsx:7-9,275-300`;
   `app/src/renderer/lib/terminal-cache.ts:14-33`;
   `app/src/renderer/features/command-room/PaneShell.tsx:170-183`.
8. **Final refit only.** After a successful cross-row swap, emit one unpaired
   `sigma:pane-resize-end` after layout commit, matching the existing fullscreen refit precedent.
   Never emit resize-start or resize continuously for reorder.
   `app/src/renderer/features/command-room/PaneGrid.tsx:195-210`.

### Interaction contract

Use a dedicated `GripVertical` button in `PaneHeader`; do not make the terminal, pane body, whole
header, or existing title pill the reorder activator.

| Interaction | Existing/required transport | Must remain isolated from |
|---|---|---|
| Pane context copy | Existing title pill + native `PANE_DRAG_MIME` + copy | Reorder |
| Pane reorder | New grip + installed `@dnd-kit/core` pointer/keyboard sensors | Context/file/skill DnD |
| Files/images/skills | Existing native HTML5 `DataTransfer` handlers | Reorder |
| Pane resize | Existing divider pointer capture | Reorder |
| Window movement | Electron titlebar drag regions | Pane headers |

- `@dnd-kit/core` is already installed and used by Tasks; `@dnd-kit/sortable` is not installed and
  is unnecessary for target-slot swaps. `app/package.json:35`;
  `app/src/renderer/features/tasks/TasksRoom.tsx:87-89,187-225`.
- The grip is a real `type="button"`, always discoverable at low opacity, fully visible on
  hover/focus, and labelled “Reorder <name>, position X of N”. Use a 4–6 px pointer activation
  threshold, `touch-action: none`, focus ring, and `noDragStyle()` defensively.
- PaneGrid currently activates a session on every captured mousedown. Exempt
  `[data-pane-reorder-handle]` so starting a reorder does not change active session or clear
  attention. `app/src/renderer/features/command-room/PaneGrid.tsx:310-315`.
- Temporarily suppress pointer hit-testing on terminal surfaces only for the active reorder, so
  crossing a TUI cannot emit mouse-tracking bytes. Always restore on drop, Escape, pointer cancel,
  workspace/route change, lost capture, and unmount.
- The source stays in layout and dims; the drag overlay is a lightweight header label, never a
  cloned live terminal. The target gets a clear 2 px ring. Reduced motion disables settle
  animation.
- Disable reordering with one pane or during fullscreen. A minimised pane remains reorderable from
  its visible header.
- Keyboard: Tab focuses the grip; Space/Enter picks up, arrow keys select a target slot,
  Space/Enter drops, and Escape cancels. Announce position changes via a polite live region and
  restore focus to the moved grip by session ID after a cross-row remount.

### Confirmed bugs and follow-ups discovered during review

- 🐞 **[low, S] resize persistence accepts invalid finite fractions** — `parseFracs` validates only
  types and array lengths, so negative/zero/non-normalized numeric values can reach CSS tracks.
  Harden with finite, positive, minimum, and normalized-sum checks before adding another persisted
  layout dimension. `app/src/renderer/features/command-room/PaneGrid.tsx:74-99`.
- 🐞 **[low, S] Command Room advertises a pane-focus shortcut with no implementation** — the header
  displays `⌘⌥<N>` and PaneHeader tooltips mention it, but no matching key handler exists in the
  renderer. Either implement it against visual order or remove the claim; pane reordering must not
  make this stale affordance more misleading.
  `app/src/renderer/features/command-room/CommandRoom.tsx:1-8,434-436`;
  `app/src/renderer/features/command-room/PaneHeader.tsx:416-435`.
- 🧹 **[low, S] stale CommandRoom layout comment says “no layout state, no persistence”** — resize
  fractions are already persisted by PaneGrid. Update the comment when introducing order state.
  `app/src/renderer/features/command-room/CommandRoom.tsx:30-34`;
  `app/src/renderer/features/command-room/PaneGrid.tsx:154-179,215-221`.
- ⚠️ **[medium, M] visible order can diverge from control-plane order** — `get_app_state` publishes
  database `pane_index` order as `orderedSessionIds`. If that field is meant to describe what the
  human sees, reconcile the same UI-order record main-side; otherwise rename/document it as storage
  slot order. `app/src/main/core/control/app-state.ts:105-120,303-306`.
- ⚠️ **[medium, M] multi-window layout updates are not live-broadcast** — KV is shared, but two
  windows showing the same workspace would not immediately observe each other's reorder. Define
  last-writer-wins plus a layout-changed event, or explicitly scope V1 ordering per window/device.
  The workspace UI helper is best-effort persistence only.
  `app/src/renderer/lib/workspace-ui-kv.ts:18-46`.

### Required regression matrix

#### Pure helpers

- Same source/target or unknown IDs are no-ops and preserve the original reference.
- 3-, 5-, 7-, and 12-pane same-row/cross-row swaps remain exact permutations.
- Reconciliation drops malformed, duplicate, stale, and foreign IDs; appends every missing live ID
  exactly once in backend order.
- Relaunch replacement substitutes the new ID at the old ID's visual index.

#### Component behavior

- DOM cell order and displayed pane ordinals follow the presentation order.
- Same-shape reorder preserves `--pg-rows`, every `--pg-cols`, and the resize KV blob byte-for-byte.
- Active/focused/attention IDs remain unchanged; dragging the grip does not focus the source.
- Same-row and cross-row swaps commit once; same-target, outside-drop, Escape, cancel, and unmount
  leave order unchanged and fully restore cursor/selection/pointer state.
- Existing title-pill drag still emits only context-copy intent and works in PaneFooter, SideChat,
  and Jorvis. Grip drag never injects context.
- Terminal selection, TUI mouse tracking, Finder/image/file-tree/skill drops, rename, header actions,
  divider resize, and Electron titlebar drag remain unchanged.
- Fullscreen and one-pane grids disable reorder; minimised panes can still move.
- Cross-row commit performs at most one final refit and produces no intermediate SIGWINCH storm.

#### Persistence and lifecycle

- Order is isolated per workspace, survives reopen/restart, rejects stale async reads, and remains
  usable when a best-effort KV write fails.
- Close prunes the ID without resurrection; add/split appends; crash-relaunch replaces in place;
  redock/refetch does not reset visual order.
- A moved terminal keeps the same session ID, PTY PID, scrollback/cache entry, provider metadata,
  worktree, active state, and attention state.

#### Real Electron smoke

- Exercise 3/5/7/12 panes at minimum and wide window sizes.
- Resize first, swap within/across rows, type into the moved pane, restart, and verify order,
  focus glow, scrollback, square corners, no overlap/dead space, and no duplicate/garbled terminal.
- Preserve the existing ≥90% pane-grid fill assertion.
  `app/tests/e2e/pane-split.spec.ts:89-115`.

### Verification receipt

Focused baseline before documentation edit:

```text
Test Files  5 passed (5)
Tests       117 passed (117)
```

Suites: pane-grid shape, PaneGrid, PaneDivider, PaneHeader, and the existing workspace
drag-to-reorder precedent. No production code was changed during this review.
