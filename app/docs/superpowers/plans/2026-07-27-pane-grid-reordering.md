# Command Room Pane Grid Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators drag or keyboard-move a Command Room pane onto another pane to swap their visual positions, while preserving every existing pane identity, terminal, grid-shape, resize, focus, and lifecycle invariant.

**Architecture:** Keep backend session order and database `pane_index` untouched. Add a renderer-only, workspace-scoped presentation-order hook that reconciles a versioned list of session IDs with the canonical live sessions, then pass that projection through `CommandRoom` into the existing `PaneGrid`. Implement exact target-slot swaps with `@dnd-kit/core`, a dedicated header grip, fixed grid geometry, a lightweight overlay, and one post-commit terminal refit for cross-row moves.

**Tech Stack:** React 19, TypeScript 5.9, Vitest, Testing Library, `@dnd-kit/core` 6.3.1, Tailwind CSS, Electron/Playwright, existing `workspace-ui-kv` persistence.

## Global Constraints

- V1 semantics are exact drop-on-pane swap; insertion and freeform positioning are out of scope.
- Never mutate or reinterpret `agent_sessions.pane_index`; it remains a launcher/resume slot.
- Never reorder the global `sessionsByWorkspace` array; only the Command Room projection changes.
- Preserve `paneRows()` and `shapeSignature()` behavior, row/column CSS variables, and the existing `panegrid.<workspaceId>` resize blob byte-for-byte during same-count reorders.
- Persist pane order separately as version `1` under `ui.<workspaceId>.commandRoom.paneOrder`.
- Persist only explicit user swaps or lifecycle ID replacements. Passive reconciliation must not write, which prevents an incompletely hydrated renderer from overwriting a valid saved order.
- New live IDs append in canonical backend order; stale, foreign, duplicate, empty, and malformed IDs never create, hide, duplicate, or resurrect panes.
- Keep title-pill native `PANE_DRAG_MIME` copy dragging, file/image/skill drops, divider pointer capture, pane rename/actions, and Electron window dragging isolated from reorder DnD.
- Reordering is disabled until order hydration completes, with fewer than two panes, and while any pane is fullscreen. Minimized panes remain reorderable.
- Do not live-reorder while hovering. The React pane tree changes once, on a valid drop.
- Pointer activation requires 5 px movement. Keyboard operation is Space/Enter to pick up/drop, arrow keys to choose a target, and Escape to cancel.
- A successful cross-row swap emits exactly one unpaired `sigma:pane-resize-end` after the reordered layout commits; it never emits `sigma:pane-resize-start`.
- Preserve active, focused, fullscreen, attention, session, PTY, renderer/cache, provider, worktree, and scratch-tab identities by session ID.
- Respect `prefers-reduced-motion` and restore keyboard focus to the moved pane's grip after a cross-row remount.
- V1 is last-explicit-write-wins across multiple windows. Live multi-window broadcasting and control-plane visible-order parity are separate follow-up plans.
- Do not add `@dnd-kit/sortable`; `@dnd-kit/core` already provides every primitive needed for target-slot swapping.

---

## File Structure

### New files

- `app/src/shared/pane-order.ts` — pure parse, serialize, reconcile, swap, and lifecycle-replacement functions.
- `app/src/shared/pane-order.test.ts` — exhaustive permutation and malformed-record coverage.
- `app/src/renderer/features/command-room/usePaneOrder.ts` — workspace hydration, explicit commits, stale-read protection, and lifecycle replacement queue.
- `app/src/renderer/features/command-room/usePaneOrder.test.ts` — hook persistence, workspace isolation, failure, and race coverage.
- `app/src/renderer/features/command-room/pane-reorder-navigation.ts` — DnD identifiers and deterministic keyboard target selection.
- `app/src/renderer/features/command-room/pane-reorder-navigation.test.ts` — uneven-row keyboard movement coverage.
- `app/src/renderer/features/command-room/PaneReorderHandle.tsx` — dedicated accessible draggable grip.
- `app/src/renderer/features/command-room/PaneReorderHandle.test.tsx` — activator, disabled, label, and interaction-isolation coverage.
- `app/src/renderer/features/command-room/PaneGridCell.tsx` — droppable pane cell, focus-capture guard, target/source styling, and terminal pointer shield.
- `app/src/renderer/features/command-room/PaneGridCell.test.tsx` — droppable state and activation-isolation coverage.
- `app/tests/e2e/pane-reorder.spec.ts` — opt-in real Electron smoke for pointer swap, persistence, fill, and terminal identity.

### Modified files

- `app/src/renderer/features/command-room/PaneHeader.tsx` — render the reorder handle separately from the existing context-copy title pill.
- `app/src/renderer/features/command-room/PaneHeader.test.tsx` — prove both drag channels remain distinct.
- `app/src/renderer/features/command-room/PaneShell.tsx` — carry pane count and reorder-enabled state from the room to the header.
- `app/src/renderer/features/command-room/PaneShell.test.tsx` — update the fixture and verify prop forwarding.
- `app/src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx` — add the missing pane-context drop regression while the new drag channel is introduced.
- `app/src/renderer/features/command-room/PaneGrid.tsx` — own DnD sensors, overlay, announcements, drop commit, cleanup, and post-swap refit while leaving resize code intact.
- `app/src/renderer/features/command-room/PaneGrid.test.tsx` — pointer/keyboard swap, cancel, geometry, resize-event, focus, and cleanup regression coverage.
- `app/src/renderer/features/command-room/CommandRoom.tsx` — derive ordered sessions, wire swaps, use visual ordinals, and replace crashed pane IDs in place.
- `app/src/renderer/features/command-room/CommandRoom.test.tsx` — projection, lifecycle, persistence, focus, add/close, and workspace-isolation integration coverage.
- `WISHLIST.md` — mark the deep review implemented only after the full gate and manual smoke pass.

---

### Task 1: Build the pure pane-order model

**Files:**
- Create: `app/src/shared/pane-order.ts`
- Create: `app/src/shared/pane-order.test.ts`

**Interfaces:**
- Consumes: canonical live session IDs from the renderer and raw workspace KV strings.
- Produces:

```ts
export const PANE_ORDER_VERSION = 1 as const;

export interface PersistedPaneOrderV1 {
  version: typeof PANE_ORDER_VERSION;
  sessionIds: string[];
}

export function parsePaneOrder(raw: string | null): string[];
export function serializePaneOrder(sessionIds: readonly string[]): string;
export function reconcilePaneOrder(
  preferredIds: readonly string[],
  liveIds: readonly string[],
): string[];
export function swapPaneIds(
  order: string[],
  sourceId: string,
  targetId: string,
): string[];
export function replacePaneOrderId(
  order: string[],
  oldId: string,
  newId: string,
): string[];
```

- No-op `swapPaneIds` and `replacePaneOrderId` calls return the original array reference.
- `parsePaneOrder` accepts only `{version: 1, sessionIds: [...]}`; it returns `[]` for invalid JSON, the wrong version, or the wrong record shape, and filters empty/non-string/duplicate entries from a valid record.

- [ ] **Step 1: Write failing parser and serializer tests.**

```ts
import { describe, expect, it } from 'vitest';
import {
  parsePaneOrder,
  reconcilePaneOrder,
  replacePaneOrderId,
  serializePaneOrder,
  swapPaneIds,
} from './pane-order';

describe('pane-order persistence', () => {
  it('round-trips a versioned record', () => {
    expect(parsePaneOrder(serializePaneOrder(['a', 'b']))).toEqual(['a', 'b']);
  });

  it.each([null, '', '{', '[]', '{"version":2,"sessionIds":["a"]}', '{"version":1,"sessionIds":"a"}'])
    ('rejects malformed or unsupported input: %s', (raw) => {
      expect(parsePaneOrder(raw)).toEqual([]);
    });

  it('filters empty, non-string, and duplicate IDs', () => {
    expect(parsePaneOrder('{"version":1,"sessionIds":["a","",7,"a","b"]}'))
      .toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the new test and verify the module-not-found failure.**

Run: `pnpm vitest run src/shared/pane-order.test.ts`

Expected: FAIL because `./pane-order` does not exist.

- [ ] **Step 3: Write failing reconciliation, swap, and replacement tests.**

```ts
describe('reconcilePaneOrder', () => {
  it('keeps saved live IDs, drops stale IDs, and appends missing live IDs canonically', () => {
    expect(reconcilePaneOrder(['c', 'stale', 'a', 'c'], ['a', 'b', 'c', 'd']))
      .toEqual(['c', 'a', 'b', 'd']);
  });

  it('never hides or duplicates a live pane', () => {
    expect(reconcilePaneOrder([], ['a', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('swapPaneIds', () => {
  it.each([
    [['a', 'b', 'c'], 'a', 'c', ['c', 'b', 'a']],
    [['a', 'b', 'c', 'd', 'e'], 'e', 'b', ['a', 'e', 'c', 'd', 'b']],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'g', 'c', ['a', 'b', 'g', 'd', 'e', 'f', 'c']],
  ])('swaps exactly two identities', (input, source, target, expected) => {
    expect(swapPaneIds(input, source, target)).toEqual(expected);
  });

  it('preserves the input reference for same-target and unknown IDs', () => {
    const order = ['a', 'b'];
    expect(swapPaneIds(order, 'a', 'a')).toBe(order);
    expect(swapPaneIds(order, 'missing', 'b')).toBe(order);
  });
});

describe('replacePaneOrderId', () => {
  it('keeps a relaunched pane in the crashed pane slot', () => {
    expect(replacePaneOrderId(['a', 'crashed', 'c'], 'crashed', 'replacement'))
      .toEqual(['a', 'replacement', 'c']);
  });

  it('is a reference-preserving no-op for missing, identical, empty, or duplicate replacements', () => {
    const order = ['a', 'b'];
    expect(replacePaneOrderId(order, 'missing', 'c')).toBe(order);
    expect(replacePaneOrderId(order, 'a', 'a')).toBe(order);
    expect(replacePaneOrderId(order, 'a', '')).toBe(order);
    expect(replacePaneOrderId(order, 'a', 'b')).toBe(order);
  });
});
```

- [ ] **Step 4: Implement the minimal pure functions.**

Use `Set` membership for reconciliation, copy only for successful swaps/replacements, and serialize exactly this shape:

```ts
return JSON.stringify({ version: PANE_ORDER_VERSION, sessionIds });
```

Do not import database, RPC, React, or grid-shape code into this module.

- [ ] **Step 5: Run pure helper tests.**

Run: `pnpm vitest run src/shared/pane-order.test.ts src/shared/pane-grid-shape.test.ts`

Expected: both files PASS, including the existing order-preservation invariant in `pane-grid-shape.test.ts`.

- [ ] **Step 6: Commit.**

```bash
git add app/src/shared/pane-order.ts app/src/shared/pane-order.test.ts
git commit -m "feat(panes): add pure presentation-order model"
```

---

### Task 2: Add workspace-scoped order hydration and explicit persistence

**Files:**
- Create: `app/src/renderer/features/command-room/usePaneOrder.ts`
- Create: `app/src/renderer/features/command-room/usePaneOrder.test.ts`

**Interfaces:**
- Consumes: Task 1 functions and `readWorkspaceUi`/`writeWorkspaceUi` from `app/src/renderer/lib/workspace-ui-kv.ts`.
- Produces:

```ts
export const COMMAND_ROOM_PANE_ORDER_PANEL = 'commandRoom.paneOrder';

export interface UsePaneOrderArgs {
  workspaceId: string | null;
  canonicalSessionIds: string[];
}

export interface UsePaneOrderResult {
  orderedSessionIds: string[];
  reorderReady: boolean;
  swapPanes: (sourceId: string, targetId: string) => boolean;
  replaceSessionId: (oldId: string, newId: string) => boolean;
}

export function usePaneOrder(args: UsePaneOrderArgs): UsePaneOrderResult;
```

- `swapPanes` returns `false` until the active workspace read completes or when the helper returns the same reference.
- `replaceSessionId` must also work before the read completes: queue `{oldId,newId}` for that workspace, apply it to the eventual persisted record, and use an optimistic replacement of the current canonical projection so the pane does not flash at the bottom.
- A late read for workspace A must never alter or write workspace B.
- A failed read is treated as an empty saved order and marks the current workspace ready.
- Writes are best-effort and occur only after a successful explicit swap or an applied lifecycle replacement.

- [ ] **Step 1: Write the hydration/reconciliation tests.**

Use `renderHook`, `act`, and `waitFor`. Mock the workspace helper at the module boundary:

```ts
const readWorkspaceUiMock = vi.fn<(
  workspaceId: string,
  panel: string,
) => Promise<string | null>>();
const writeWorkspaceUiMock = vi.fn<(
  workspaceId: string,
  panel: string,
  value: string,
) => Promise<void>>();

vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...args: [string, string]) => readWorkspaceUiMock(...args),
  writeWorkspaceUi: (...args: [string, string, string]) => writeWorkspaceUiMock(...args),
}));
```

Cover these assertions:

```ts
expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-1', 'commandRoom.paneOrder');
expect(result.current.orderedSessionIds).toEqual(['c', 'a', 'b']);
expect(result.current.reorderReady).toBe(true);
expect(writeWorkspaceUiMock).not.toHaveBeenCalled(); // hydration/reconciliation is read-only
```

- [ ] **Step 2: Run the hook test and verify the missing-module failure.**

Run: `pnpm vitest run src/renderer/features/command-room/usePaneOrder.test.ts`

Expected: FAIL because `usePaneOrder.ts` does not exist.

- [ ] **Step 3: Add explicit swap/persistence tests.**

After hydration, call `swapPanes('c', 'b')` and assert:

```ts
expect(result.current.swapPanes('c', 'b')).toBe(true);
expect(result.current.orderedSessionIds).toEqual(['b', 'a', 'c']);
expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
  'ws-1',
  'commandRoom.paneOrder',
  '{"version":1,"sessionIds":["b","a","c"]}',
);
```

Also assert same-target/unknown swaps return `false`, do not render, and do not write.

- [ ] **Step 4: Add race and lifecycle tests.**

Use deferred promises to cover all four races:

1. Switch from `ws-a` to `ws-b`, resolve `ws-a` last, and assert B remains displayed and A never writes B's key.
2. Call `replaceSessionId('old', 'new')` while the read is pending; render `new` at `old`'s optimistic slot, then resolve the saved record and assert the queued replacement is applied and persisted once.
3. Rerender canonical IDs after close/add; assert stale IDs disappear and new IDs append without a passive write.
4. Reject read/write promises; assert canonical order remains usable and no rejection escapes the hook.

- [ ] **Step 5: Implement the hook with workspace-tagged state.**

Use this internal state rather than a global reducer:

```ts
interface PendingReplacement {
  oldId: string;
  newId: string;
}

interface LoadedPaneOrder {
  workspaceId: string | null;
  preferredIds: string[];
  ready: boolean;
  pendingReplacements: PendingReplacement[];
}
```

On `workspaceId` change, synchronously expose canonical order with `ready:false`, start one cancellable read, and discard its resolution if the effect was cleaned up. On read completion, apply every queued replacement to the parsed saved order before setting `ready:true`; if replacements were applied, persist that transformed record once. Derive `orderedSessionIds` with `reconcilePaneOrder(preferredIds, canonicalSessionIds)` on every render. Store the latest derived IDs and workspace ID in refs used by the two mutation callbacks so asynchronous lifecycle handlers never close over stale order.

- [ ] **Step 6: Run hook and persistence-helper tests.**

Run: `pnpm vitest run src/renderer/features/command-room/usePaneOrder.test.ts src/renderer/lib/workspace-ui-kv.test.ts src/shared/pane-order.test.ts`

Expected: all files PASS.

- [ ] **Step 7: Commit.**

```bash
git add app/src/renderer/features/command-room/usePaneOrder.ts app/src/renderer/features/command-room/usePaneOrder.test.ts
git commit -m "feat(panes): persist workspace presentation order"
```

---

### Task 3: Define deterministic drag IDs and uneven-grid keyboard movement

**Files:**
- Create: `app/src/renderer/features/command-room/pane-reorder-navigation.ts`
- Create: `app/src/renderer/features/command-room/pane-reorder-navigation.test.ts`

**Interfaces:**
- Consumes: `paneRows()` from `app/src/shared/pane-grid-shape.ts` and `KeyboardCoordinateGetter` from `@dnd-kit/core`.
- Produces:

```ts
export type PaneArrowCode = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export function paneDragId(sessionId: string): string;
export function paneDropId(sessionId: string): string;
export function sessionIdFromPaneDragId(id: unknown): string | null;
export function sessionIdFromPaneDropId(id: unknown): string | null;
export function paneTargetForArrow(
  sessionIds: readonly string[],
  currentSessionId: string,
  code: PaneArrowCode,
): string | null;
export function createPaneKeyboardCoordinates(
  sessionIds: readonly string[],
): import('@dnd-kit/core').KeyboardCoordinateGetter;
```

- IDs are `pane-reorder:<sessionId>` and `pane-slot:<sessionId>`; parsers reject the wrong prefix and an empty suffix.
- Left/right select the previous/next flattened visual slot without wrapping.
- Up/down use `paneRows(sessionIds)`, move one row, and clamp the current column to the target row's last column. This makes five-pane `[a,b,c]/[d,e]` movement deterministic: Down from `c` selects `e`, Up from `e` selects `b`.
- The coordinate getter uses `context.over` when present, otherwise the active ID; it returns the target droppable rectangle's center from `context.droppableRects`, or `currentCoordinates` when no move is possible.

- [ ] **Step 1: Write the failing ID and arrow-navigation tests.**

```ts
expect(paneTargetForArrow(['a', 'b', 'c', 'd', 'e'], 'c', 'ArrowDown')).toBe('e');
expect(paneTargetForArrow(['a', 'b', 'c', 'd', 'e'], 'e', 'ArrowUp')).toBe('b');
expect(paneTargetForArrow(['a', 'b', 'c', 'd', 'e'], 'd', 'ArrowLeft')).toBe('c');
expect(paneTargetForArrow(['a', 'b', 'c'], 'a', 'ArrowLeft')).toBeNull();
expect(sessionIdFromPaneDragId(paneDragId('session-1'))).toBe('session-1');
expect(sessionIdFromPaneDropId('wrong:session-1')).toBeNull();
```

Repeat row-navigation assertions for 3, 7, and 12 IDs.

- [ ] **Step 2: Run the test and verify the missing-module failure.**

Run: `pnpm vitest run src/renderer/features/command-room/pane-reorder-navigation.test.ts`

Expected: FAIL because the navigation module does not exist.

- [ ] **Step 3: Implement ID parsing and pure arrow navigation.**

Use `paneRows([...sessionIds])`; do not duplicate the square-root grid-shape algorithm.

- [ ] **Step 4: Add a coordinate-getter test with two fake droppable rectangles.**

Call the getter with `ArrowRight`, an active drag ID for `a`, an over drop ID for `a`, and a `droppableRects` map containing the `b` rectangle. Assert it returns `b`'s exact center and calls `event.preventDefault()`.

- [ ] **Step 5: Implement `createPaneKeyboardCoordinates`.**

Only handle the four `PaneArrowCode` values. For other keys, return `currentCoordinates` without preventing default. Use the public `KeyboardCoordinateGetter` arguments; do not inspect private DnD-kit state.

- [ ] **Step 6: Run navigation and shape tests.**

Run: `pnpm vitest run src/renderer/features/command-room/pane-reorder-navigation.test.ts src/shared/pane-grid-shape.test.ts`

Expected: both files PASS.

- [ ] **Step 7: Commit.**

```bash
git add app/src/renderer/features/command-room/pane-reorder-navigation.ts app/src/renderer/features/command-room/pane-reorder-navigation.test.ts
git commit -m "feat(panes): add deterministic reorder navigation"
```

---

### Task 4: Add a dedicated accessible reorder grip without changing the title drag

**Files:**
- Create: `app/src/renderer/features/command-room/PaneReorderHandle.tsx`
- Create: `app/src/renderer/features/command-room/PaneReorderHandle.test.tsx`
- Modify: `app/src/renderer/features/command-room/PaneHeader.tsx:10-27,72-118,180-280`
- Modify: `app/src/renderer/features/command-room/PaneHeader.test.tsx:110-238`
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx:72-128` and its `<PaneHeader>` call
- Modify: `app/src/renderer/features/command-room/PaneShell.test.tsx` fixture props

**Interfaces:**
- Consumes: `paneDragId()` from Task 3, `useDraggable()` from `@dnd-kit/core`, `GripVertical` from `lucide-react`, and `noDragStyle()` from `app/src/renderer/lib/drag-region.ts`.
- Produces:

```ts
export interface PaneReorderHandleProps {
  sessionId: string;
  paneName: string;
  position: number;
  count: number;
  disabled: boolean;
}

export function PaneReorderHandle(props: PaneReorderHandleProps): React.ReactNode;
```

- Add required `paneCount: number` and `canReorder: boolean` props to `PaneShell`.
- Add optional `paneCount?: number` and `canReorder?: boolean` props to `PaneHeader`, defaulting to `1` and `false` so isolated/split callers remain safe until explicitly wired.

- [ ] **Step 1: Write the failing handle tests.**

Render inside a real `DndContext` and assert:

```tsx
const grip = screen.getByRole('button', {
  name: 'Reorder Claude Alpha, position 2 of 5',
});
expect(grip).toHaveAttribute('data-pane-reorder-handle', 'true');
expect(grip).toHaveAttribute('data-session-id', 's2');
expect(grip).toHaveStyle({ touchAction: 'none' });
```

Also assert the disabled prop sets the native `disabled` attribute and DnD-kit `aria-disabled`, and that Enter/Space listeners come from DnD-kit rather than calling pane focus.

- [ ] **Step 2: Run the handle test and verify the missing-module failure.**

Run: `pnpm vitest run src/renderer/features/command-room/PaneReorderHandle.test.tsx`

Expected: FAIL because `PaneReorderHandle.tsx` does not exist.

- [ ] **Step 3: Implement the grip.**

Call `useDraggable` with:

```ts
useDraggable({
  id: paneDragId(sessionId),
  data: { kind: 'pane-reorder', sessionId },
  disabled,
  attributes: { role: 'button', roleDescription: 'sortable pane' },
});
```

Attach both `setNodeRef` and `setActivatorNodeRef` to the button, spread `attributes` and `listeners`, and render `GripVertical` at `h-3.5 w-3.5`. Apply `type="button"`, `touchAction:'none'`, `noDragStyle()`, a visible focus ring, low resting opacity, full hover/focus opacity, `cursor-grab`, and `active:cursor-grabbing`. The component must not set `draggable`, `DataTransfer`, transforms, or pane focus handlers.

- [ ] **Step 4: Wire the grip through PaneHeader and PaneShell.**

Render the new grip as its own control immediately before the existing title pill. Pass the resolved `paneName`, the visual `paneIndex`, total count, and enabled state. Do not alter `handleGripDragStart`, `PANE_DRAG_MIME`, or `data-testid="pane-title-pill"`; rename the old comment/function locally to “context drag” where that improves clarity, without changing behavior.

- [ ] **Step 5: Add interaction-isolation tests.**

In `PaneHeader.test.tsx`, retain the current title-pill assertion and add:

- the title pill is still native-draggable and writes only `application/sigmalink-pane` with `effectAllowed='copy'`;
- the reorder grip has no native `draggable="true"` and never calls `dataTransfer.setData`;
- double-click rename, gear, split, minimize, fullscreen, and close remain separate buttons;
- `canReorder=false`, one pane, and fullscreen-derived disablement produce a disabled grip.

In `PaneShell.test.tsx`, mock `PaneHeader` with a prop-capturing function and assert `paneCount` and `canReorder` pass through unchanged.

Retain the existing pane-context drop assertions in `PaneFooter.test.tsx` and `SideChat.test.tsx`. Add the equivalent missing assertion to `JorvisRoom.test.tsx`: drop a valid `application/sigmalink-pane` payload on the wrapper containing the Jorvis composer, resolve the mocked `buildPaneContext`, and assert the returned context is inserted into the composer. This proves the new DnD-kit grip has not replaced the native title-pill transport used by any of the three destinations.

- [ ] **Step 6: Run header/shell/handle tests.**

Run: `pnpm vitest run src/renderer/features/command-room/PaneReorderHandle.test.tsx src/renderer/features/command-room/PaneHeader.test.tsx src/renderer/features/command-room/PaneShell.test.tsx src/renderer/features/command-room/PaneFooter.test.tsx src/renderer/features/swarm-room/SideChat.test.tsx src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx src/renderer/lib/pane-context-builder.test.ts`

Expected: all files PASS and the pre-existing context-copy drag test remains green.

- [ ] **Step 7: Commit.**

```bash
git add app/src/renderer/features/command-room/PaneReorderHandle.tsx app/src/renderer/features/command-room/PaneReorderHandle.test.tsx app/src/renderer/features/command-room/PaneHeader.tsx app/src/renderer/features/command-room/PaneHeader.test.tsx app/src/renderer/features/command-room/PaneShell.tsx app/src/renderer/features/command-room/PaneShell.test.tsx app/src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx
git commit -m "feat(panes): add dedicated reorder grip"
```

---

### Task 5: Add drop targets and one-shot PaneGrid swap orchestration

**Files:**
- Create: `app/src/renderer/features/command-room/PaneGridCell.tsx`
- Create: `app/src/renderer/features/command-room/PaneGridCell.test.tsx`
- Modify: `app/src/renderer/features/command-room/PaneGrid.tsx:28-45,111-130,185-210,264-357`
- Modify: `app/src/renderer/features/command-room/PaneGrid.test.tsx`

**Interfaces:**
- Consumes: Task 3 navigation/ID helpers, `PaneReorderHandle` descendants supplied by `renderLeaf`, and `@dnd-kit/core` sensors/context/overlay.
- Produces these additions to `PaneGridProps`:

```ts
reorderEnabled: boolean;
onSwapPanes: (sourceSessionId: string, targetSessionId: string) => boolean;
getPaneLabel: (sessionId: string) => string;
```

- `PaneGridCell` consumes the existing cell state plus:

```ts
interface PaneGridCellProps {
  sessionId: string;
  reorderEnabled: boolean;
  isReordering: boolean;
  isReorderSource: boolean;
  isActive: boolean;
  isFocused: boolean;
  isHidden: boolean;
  onActivate: (sessionId: string) => void;
  children: React.ReactNode;
}
```

- [ ] **Step 1: Write failing PaneGridCell tests.**

Mock `useDroppable` to return a ref spy and controlled `isOver`. Verify:

- ID is `pane-slot:<sessionId>` with `{kind:'pane-reorder-target',sessionId}` data;
- `isOver` adds a 2 px target ring without changing cell dimensions;
- source gets `data-pane-reorder-source="true"` and reduced opacity;
- active reorder renders one absolute `data-testid="pane-reorder-shield"` above terminal content;
- `onMouseDownCapture` ignores any target inside `[data-pane-reorder-handle]` but activates normal pane body presses;
- inactive reorder renders no shield and preserves existing active/fullscreen/hidden attributes and styles.

- [ ] **Step 2: Run the cell test and verify the missing-module failure.**

Run: `pnpm vitest run src/renderer/features/command-room/PaneGridCell.test.tsx`

Expected: FAIL because `PaneGridCell.tsx` does not exist.

- [ ] **Step 3: Implement PaneGridCell and replace only the cell wrapper.**

Move the current `pane-cell` attributes, stable `z-0`/`z-[1]` stacking classes, fullscreen absolute style, and `renderLeaf` child into `PaneGridCell`. Keep row fragments, row keys, divider placement, CSS grid templates, and session keys unchanged. The shield is an empty `aria-hidden="true"` absolute element with `z-30 cursor-grabbing`; it exists only while a reorder is active so terminal/TUI pointer events resume automatically on end, cancel, workspace change, or unmount.

- [ ] **Step 4: Write failing PaneGrid DnD lifecycle tests.**

Mock `DndContext` as a wrapper that captures `onDragStart`, `onDragEnd`, and `onDragCancel`, while leaving `useDraggable`/`useDroppable` controlled. Assert:

1. Pointer sensor activation is `{distance:5}` and KeyboardSensor uses `createPaneKeyboardCoordinates(sessionIds)`.
2. Drag start marks only the source and renders a lightweight overlay label, never a cloned `renderLeaf` or terminal.
3. `pane-reorder:a` dropped on `pane-slot:e` calls `onSwapPanes('a','e')` once.
4. Same-target, missing-target, wrong-prefix, disabled, outside-drop, Escape/cancel, and unmount call no swap.
5. End/cancel removes source dimming, target ring, overlay, shields, selection suppression, and grabbing cursor.
6. Dragging the reorder grip does not call `onActivate`, clear attention, or emit native pane-context MIME.

- [ ] **Step 5: Wrap the existing grid with DndContext.**

Use:

```ts
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  useSensor(KeyboardSensor, {
    coordinateGetter: createPaneKeyboardCoordinates(sessionIds),
  }),
);
```

Use pointer collisions when coordinates exist, otherwise `closestCenter` for keyboard operation. Store only `activeReorderId` in React state during hover; derive the current target from DnD-kit `over`/`isOver`. The source pane remains in its original grid slot and only its grip is the draggable node. Render a `DragOverlay` containing a small label from `getPaneLabel(activeReorderId)` and position text, with zero-duration drop animation under reduced motion.

Configure DnD-kit announcements to produce these meanings:

- pickup: “Picked up &lt;label&gt;, position X of N.”
- over: “&lt;label&gt; will swap with position Y of N.”
- drop: “Moved &lt;label&gt; to position Y of N.”
- cancel: “Pane move cancelled.”

- [ ] **Step 6: Implement post-commit focus restore and cross-row refit.**

Before calling `onSwapPanes`, compare the source and target row indices from `paneRows(sessionIds)`. If the callback returns `true`, store the source session ID for focus restoration. For cross-row swaps, arm a refit ref. A `useLayoutEffect` keyed by `sessionIds.join('\u0000')` must, after the parent supplies the changed order:

1. focus the matching `[data-pane-reorder-handle][data-session-id]` inside `containerRef` using `{preventScroll:true}`;
2. if cross-row refit was armed, dispatch one unpaired `new CustomEvent('sigma:pane-resize-end')` and clear the ref;
3. never dispatch `sigma:pane-resize-start` for reorder.

Do not touch the existing divider `beginDrag`, `applyDrag`, `endDrag`, resize persistence, or fullscreen refit effect.

- [ ] **Step 7: Add geometry and refit regression tests.**

Seed a non-even resize record via the existing `rpcSilent.kv.get` mock, perform same-row and cross-row swaps, and assert:

- `--pg-rows`, every `--pg-cols`, and the serialized `panegrid.<workspaceId>` value are unchanged;
- same-row swap emits no reorder refit event;
- cross-row swap emits exactly one `sigma:pane-resize-end` after rerender with changed `sessionIds`;
- no swap emits `sigma:pane-resize-start`;
- `data-active`, fullscreen, and hidden state follow the same session IDs after order changes;
- the moved grip owns `document.activeElement` after cross-row rerender.

- [ ] **Step 8: Run PaneGrid and divider regression tests.**

Run: `pnpm vitest run src/renderer/features/command-room/PaneGridCell.test.tsx src/renderer/features/command-room/PaneGrid.test.tsx src/renderer/features/command-room/PaneDivider.test.tsx src/shared/pane-grid-shape.test.ts`

Expected: all files PASS, with the existing resize start/end pairing tests unchanged.

- [ ] **Step 9: Commit.**

```bash
git add app/src/renderer/features/command-room/PaneGridCell.tsx app/src/renderer/features/command-room/PaneGridCell.test.tsx app/src/renderer/features/command-room/PaneGrid.tsx app/src/renderer/features/command-room/PaneGrid.test.tsx
git commit -m "feat(panes): swap grid positions by drag and keyboard"
```

---

### Task 6: Integrate visual ordering and crash-relaunch replacement in CommandRoom

**Files:**
- Modify: `app/src/renderer/features/command-room/CommandRoom.tsx:10-34,36-75,281-317,397-500`
- Modify: `app/src/renderer/features/command-room/CommandRoom.test.tsx`

**Interfaces:**
- Consumes: `usePaneOrder()` from Task 2 and the new PaneGrid/PaneShell props from Tasks 4-5.
- Produces: one ordered Command Room projection used consistently for grid IDs, lookup, displayed pane ordinal, labels, and reorder capability.

- [ ] **Step 1: Write failing ordered-projection tests.**

Mock workspace order KV to return `{"version":1,"sessionIds":["s3","s1","s2"]}` for `ws-1`. Seed canonical sessions as `[s1,s2,s3]`, wait for hydration, then assert pane cells and header ordinals render in `s3,s1,s2` order while `mockState.sessionsByWorkspace['ws-1']` remains `[s1,s2,s3]`.

Assert `PaneGrid` receives `reorderEnabled=false` before hydration, `true` after hydration with at least two panes and no fullscreen pane, and `false` for one pane or fullscreen.

- [ ] **Step 2: Run the CommandRoom test and verify the order assertions fail.**

Run: `pnpm vitest run src/renderer/features/command-room/CommandRoom.test.tsx`

Expected: FAIL because CommandRoom still passes canonical session order directly.

- [ ] **Step 3: Derive and use the ordered projection.**

Add:

```ts
const canonicalSessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
const {
  orderedSessionIds,
  reorderReady,
  swapPanes,
  replaceSessionId,
} = usePaneOrder({ workspaceId: activeWorkspaceId, canonicalSessionIds });
const sessionsById = useMemo(
  () => new Map(sessions.map((session) => [session.id, session])),
  [sessions],
);
const canReorder = reorderReady && orderedSessionIds.length > 1 && focusedPaneId === null;
```

Pass `orderedSessionIds` to PaneGrid. Resolve `renderLeaf` via `sessionsById.get(sessionId)`, calculate `paneIndex` from `orderedSessionIds`, pass `paneCount={orderedSessionIds.length}` and `canReorder` to PaneShell, and pass PaneGrid `onSwapPanes={swapPanes}`, `reorderEnabled={canReorder}`, and a label resolver using `session.name?.trim() || session.providerId`.

Update the stale layout comment to say canonical sessions remain authoritative while resize and presentation order are separate workspace-scoped UI state.

- [ ] **Step 4: Write failing lifecycle integration tests.**

Cover:

- adding/splitting a pane appends it through reconciliation without rewriting the stored record;
- closing a pane removes it visually without resurrection and without rewriting `pane_index` or invoking a reorder RPC;
- workspace A and B read/write only their own `ui.<workspace>.commandRoom.paneOrder` key;
- a best-effort write failure leaves the optimistic visual swap intact;
- active and attention dispatches remain unchanged when visual order changes.

For crash relaunch, seed saved order `[s1,crashed,s3]`, resolve `rpc.swarms.addAgent` with `replacement`, invoke Relaunch, and assert the call sequence is:

1. `ADD_SESSIONS(replacement)`;
2. `replaceSessionId('crashed','replacement')` persists `[s1,replacement,s3]`;
3. `SET_ACTIVE_SESSION(replacement)`;
4. `panes.close(crashed)` best-effort;
5. `REMOVE_SESSION(crashed)`.

- [ ] **Step 5: Wire lifecycle replacement before old-session removal.**

In `handleRelaunch`, call `replaceSessionId(session.id, result.sessionId)` immediately after `ADD_SESSIONS` and before `REMOVE_SESSION`. Keep all existing DB close, active-session, swarm, error, and toast behavior unchanged. Do not add order operations to normal resume because normal resume reuses the same session ID.

- [ ] **Step 6: Run CommandRoom plus order tests.**

Run: `pnpm vitest run src/renderer/features/command-room/CommandRoom.test.tsx src/renderer/features/command-room/usePaneOrder.test.ts src/shared/pane-order.test.ts`

Expected: all files PASS.

- [ ] **Step 7: Commit.**

```bash
git add app/src/renderer/features/command-room/CommandRoom.tsx app/src/renderer/features/command-room/CommandRoom.test.tsx
git commit -m "feat(panes): project persisted visual order in command room"
```

---

### Task 7: Add real Electron smoke coverage and run the full gate

**Files:**
- Create: `app/tests/e2e/pane-reorder.spec.ts`
- Modify after successful verification: `WISHLIST.md`

**Interfaces:**
- Consumes: production Electron IPC, `data-testid="pane-grid"`, `data-testid="pane-cell"`, `data-pane-reorder-handle`, and the KV key from Tasks 2-6.
- Produces: an opt-in `SIGMALINK_E2E_PANE_REORDER=1` smoke that proves the renderer behavior against live panes.

- [ ] **Step 1: Add the opt-in Electron test harness.**

Follow `app/tests/e2e/pane-split.spec.ts`: launch `electron-dist/main.js`, create a temporary workspace, set onboarding KV gates, activate the workspace through `sigma:test:activate-workspace`, and create shell-provider swarms so the test does not require Claude/Codex credentials.

Parameterize pane counts `[3, 5, 7, 12]`. For each count:

1. record visual `data-session-id` order;
2. resize one divider before moving a pane;
3. drag the last pane's reorder grip to the first pane cell;
4. assert exactly those two IDs exchange positions;
5. assert the visible pane area remains at least 90% of the grid area;
6. assert all cells retain `borderRadius === '0px'` and no rectangles overlap;
7. type a unique marker into the moved shell terminal and assert it appears in the same session-ID cell;
8. read `kv.get('ui.<workspaceId>.commandRoom.paneOrder')` and assert the versioned record matches DOM order;
9. reload/reactivate the workspace and assert the saved order returns;
10. use keyboard Space, arrow, Space on a grip and assert the announced/final target swap;
11. press Escape during another pickup and assert order remains unchanged.

Always close Electron and remove only the explicit `mkdtemp` directory in `finally`.

- [ ] **Step 2: Build Electron and run the new smoke.**

Run:

```bash
pnpm build
pnpm electron:compile
SIGMALINK_E2E_PANE_REORDER=1 pnpm playwright test tests/e2e/pane-reorder.spec.ts
```

Expected: all 3/5/7/12 pane cases PASS.

- [ ] **Step 3: Run the focused pane regression matrix.**

Run:

```bash
pnpm vitest run \
  src/shared/pane-order.test.ts \
  src/shared/pane-grid-shape.test.ts \
  src/renderer/features/command-room/usePaneOrder.test.ts \
  src/renderer/features/command-room/pane-reorder-navigation.test.ts \
  src/renderer/features/command-room/PaneReorderHandle.test.tsx \
  src/renderer/features/command-room/PaneGridCell.test.tsx \
  src/renderer/features/command-room/PaneGrid.test.tsx \
  src/renderer/features/command-room/PaneDivider.test.tsx \
  src/renderer/features/command-room/PaneHeader.test.tsx \
  src/renderer/features/command-room/PaneShell.test.tsx \
  src/renderer/features/command-room/CommandRoom.test.tsx \
  src/renderer/features/command-room/PaneFooter.test.tsx \
  src/renderer/features/swarm-room/SideChat.test.tsx \
  src/renderer/features/jorvis-assistant/JorvisRoom.test.tsx \
  src/renderer/lib/pane-context-builder.test.ts
```

Expected: every listed file PASS, including pre-existing context-copy, file/image/skill drop, resize, focus, fullscreen, minimize, rename, and header-action cases.

- [ ] **Step 4: Run the complete local gate.**

Run each command separately and inspect its exit code:

```bash
pnpm test
pnpm lint
pnpm build
pnpm electron:compile
git diff --check
```

Expected: all commands exit `0`; no new warning is accepted without documenting its exact pre-existing source.

- [ ] **Step 5: Perform the operator smoke in the supplied mixed-provider layout.**

Using a real 11-pane Command Room matching the supplied screenshot:

- drag a bottom Claude pane onto a top non-Claude pane and verify they exchange exactly;
- verify scrollback, live TUI output, input, provider label, worktree, scratch tabs, active glow, and attention remain with the same sessions;
- resize, same-row swap, cross-row swap, minimize/swap, cancel, fullscreen disablement, file/image/skill drops, title-pill context injection, and window movement;
- restart and confirm order survives;
- confirm there is no intermediate SIGWINCH/repaint storm, duplicate terminal, dead area, overlap, rounded-corner regression, or accidental context injection.

- [ ] **Step 6: Update the review receipt and commit.**

Only after Steps 2-5 pass, update the pane-reordering section in `WISHLIST.md` from “reviewed and feasible; not implemented” to the shipped commit/status and append the exact test counts and Electron smoke receipt. Do not delete the architectural safety notes.

```bash
git add app/tests/e2e/pane-reorder.spec.ts WISHLIST.md
git commit -m "test(panes): cover persisted grid reordering"
```

---

## Deferred Follow-up Plans

These are intentionally excluded from this implementation because each crosses an independent subsystem boundary:

- Main/control-plane visible-order parity for `get_app_state.orderedSessionIds`.
- Live multi-window order broadcasts beyond last-explicit-write-wins KV persistence.
- Before/after insertion semantics and `@dnd-kit/sortable` evaluation.
- Hardening `PaneGrid.parseFracs` against finite-but-invalid fractions.
- Implementing or removing the currently advertised `Cmd+Alt+N` pane-focus shortcut.

## Self-Review Notes

- **Spec coverage:** Pure order safety (Task 1), workspace persistence and stale-read protection (Task 2), uneven keyboard movement (Task 3), dedicated grip and drag-channel isolation (Task 4), one-shot DnD/geometry/refit/focus behavior (Task 5), lifecycle and visual ordinal integration (Task 6), and real Electron/full-gate verification (Task 7).
- **Layout integrity:** No task writes `pane_index`, changes `paneRows`, changes resize storage, or reorders global sessions. Resize/refit changes are additive and event-count tested.
- **Lifecycle integrity:** add, split, close, resume, relaunch, workspace switch, stale read, and failed persistence paths each have an explicit test.
- **Interaction integrity:** The new activator is a dedicated button. Native title context drag, terminal/TUI input, file/image/skill drops, divider resize, header actions, and window drag each have a preservation assertion or smoke step.
- **Accessibility:** Native button semantics, descriptive label, 5 px threshold, keyboard pickup/movement/drop/cancel, polite announcements, disabled states, reduced motion, and post-remount focus restoration are all assigned to Tasks 3-5.
- **Instruction completeness:** Every implementation step names its concrete behavior, test command, expected result, and commit boundary; no deferred work is hidden inside an active task.
- **Type consistency:** `UsePaneOrderResult.swapPanes` matches `PaneGridProps.onSwapPanes`; session-ID DnD prefixes are shared by handle, cell, keyboard navigation, and grid; `paneCount/canReorder` flow CommandRoom → PaneShell → PaneHeader → PaneReorderHandle.
- **Scope:** Control plane, live multi-window broadcast, insertion, fraction validation, and focus-shortcut cleanup are explicitly separate projects and do not block safe V1 swaps.
