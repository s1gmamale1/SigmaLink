# Terminal-Cache & Scratch-Shell Lifecycle Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the pane/terminal-cache lifecycle leak cluster from the 2026-06-10 audit: scratch-shell PTY/xterm leaks, LRU eviction blanking visible panes, WebGL context exhaustion from parked terminals, lost SIGMA::PROMPT lines across remounts, frozen link-routing context on cache hit, and the snapshot/live double-write window.

**Architecture:** All fixes ride the codebase's proven module-scope-singleton pattern (terminal-cache, pty-data-bus `hasPtyDataArrived`, use-git-status-poll's `useSyncExternalStore` store). Finding 1 hoists scratch-tab state out of PaneShell's per-mount `useState` into a new module-scope store (`src/renderer/lib/scratch-tabs.ts`) keyed by parent sessionId — chosen over "treat unmount as close" because unmount-as-close would kill a user's scratch shell on every room/workspace switch, contradicting the terminal-multiplexer mental model the whole terminal-cache exists to serve. Cleanup funnels through `use-terminal-cache-gc` because it is the single choke point that sees ALL three `REMOVE_SESSION` dispatch sites (explicit close `CommandRoom.tsx:261`, relaunch `CommandRoom.tsx:290`, exited-grace `use-exited-session-gc.ts:39`) — fixing it per-call-site would be the classic sibling-miss. Finding 4 applies the same hoist to the prompt watcher (new `src/renderer/lib/prompt-watcher.ts`). Findings 2/3/5a/5b are surgical edits inside `terminal-cache.ts` plus a 1-line main-side flush.

**Tech Stack:** React 19 (`useSyncExternalStore`), xterm.js 6 (`@xterm/xterm`, `@xterm/addon-webgl`), vitest + jsdom + @testing-library/react (existing fake-xterm / fake-bus mock patterns from `terminal-cache.test.ts` and `use-prompt-card.test.ts`), Electron IPC (main `rpc-router.ts`).

---

## Verification notes (audit findings re-checked against code, 2026-06-10)

- **Finding 1 — CONFIRMED.** `PaneShell.tsx:145` `useState<ScratchTab[]>([])` is per-mount; room/workspace switches unmount PaneShell and orphan the scratch PTY (alive in main's registry) with no UI handle. `closeScratch` (`PaneShell.tsx:170-186`) calls `rpc.pty.killScratch` but never `terminal-cache destroy(scratchId)` — the cached xterm + pty-bus subscription + (today) its WebGL context leak until 32-entry LRU. `use-terminal-cache-gc.ts:33-36` walks only `state.sessionsByWorkspace`/`state.sessions`, where scratch ids never appear. `CommandRoom.tsx:257-262` `handleRemove` kills only `session.id`.
- **Finding 2 — CONFIRMED.** `terminal-cache.ts:198-216` `evictOldestIfFull` picks `liveVictim` purely by `lastAccessed` (bumped only in `getOrCreateTerminal`/`attachToHost`). A long-visible pane that hasn't remounted recently can be destroyed while on-screen; `Terminal.tsx:155` `runFit`'s `try { fit.fit() } catch { return; }` then swallows every subsequent fit → permanently blank pane.
- **Finding 3 — CONFIRMED.** `terminal-cache.ts:264-276` loads `WebglAddon` at creation for every cached entry (cap 32) vs Chromium's ~16 WebGL-contexts-per-process cap; parked terminals hold contexts that Chromium may evict from VISIBLE panes (silent DOM-renderer downgrade via `onContextLoss`). Parked terminals only need buffer parsing — no GPU renderer.
- **Finding 4 — CONFIRMED.** `use-prompt-card.ts:63-86` subscribes to the bus only while mounted; `pty-data-bus.ts` has no replay. A `SIGMA::PROMPT` line arriving during a room switch is lost; on remount the card never shows while the CLI blocks on stdin. Snapshot-tail rescan was REJECTED: an already-answered prompt would re-surface as a false positive (the answer is not visible in the output stream), and it costs a full-buffer scan per mount. Module-scope watcher (the `hasPtyDataArrived` pattern) chosen.
- **Finding 5a — CONFIRMED.** `terminal-cache.ts:228-232` returns the cached entry without updating `ctx`; the linkHandler closure (`terminal-cache.ts:190-194`) captures the FIRST mount's `wsIdRef`/`surfaceBrowser` forever. Each `SessionTerminal` mount creates a fresh `useRef` (`Terminal.tsx:103`), so after any remount the cache reads a dead ref → links route to a stale workspace id. Contradicts the `TerminalCacheContext` interface comment ("we accept the latest reference on every getOrCreate call").
- **Finding 5b — CONFIRMED, main does NOT dedup.** Verified main-side: `registry.ts:272-273` appends each raw chunk to the ring buffer THEN hands it to the data sink; `rpc-router.ts:484` routes the sink through `PtyDataCoalescer` which delays the renderer broadcast up to 12 ms (`pty-data-coalescer.ts:42`); the snapshot handler `rpc-router.ts:995-997` reads the ring buffer with NO flush and no sequence numbers. So a byte appended before the snapshot read but broadcast-delivered after the renderer's bus subscription exists in BOTH the snapshot buffer and a live chunk → written twice (duplicated text on fast first attach). Two-part fix: main flushes the coalescer before the snapshot read (Electron orders main→renderer IPC, so the flushed broadcast lands before the RPC response → all duplicates are in `pending` by drain time), and the renderer drops the overlap between the snapshot tail and the pending stream.
- **Refuted findings: NONE.**

## File Structure

```
app/src/
├── renderer/
│   ├── lib/
│   │   ├── scratch-tabs.ts                      [CREATE — Task 1] module-scope scratch-tab store keyed by parent sessionId;
│   │   │                                          owns kill+cache-destroy on close (single choke point for tab teardown)
│   │   ├── scratch-tabs.test.ts                 [CREATE — Task 1]
│   │   ├── prompt-watcher.ts                    [CREATE — Task 4] module-scope SIGMA::PROMPT watcher (ProtocolLineBuffer +
│   │   │                                          last-prompt per sessionId; survives remounts; no React deps)
│   │   ├── prompt-watcher.test.ts               [CREATE — Task 4]
│   │   ├── terminal-cache.ts                    [MODIFY — Tasks 2, 3, 5, 6] evict guard · WebGL attach/detach · ctxRef · drain dedup
│   │   └── terminal-cache.test.ts               [MODIFY — Tasks 2, 3, 5, 6]
│   ├── features/command-room/
│   │   ├── PaneShell.tsx                        [MODIFY — Task 1] scratch state → store (net line REDUCTION; file is 629 lines,
│   │   │                                          already over the 500 cap — do not add net lines)
│   │   ├── PaneShell.test.tsx                   [MODIFY — Task 1]
│   │   ├── use-prompt-card.ts                   [MODIFY — Task 4] thin React adapter over prompt-watcher
│   │   └── use-prompt-card.test.ts              [MODIFY — Task 4] lifecycle contract changes (watcher persists across unmount)
│   └── app/state-hooks/
│       ├── use-terminal-cache-gc.ts             [MODIFY — Tasks 1, 4] reap scratch tabs + prompt watchers for vanished sessions
│       └── use-terminal-cache-gc.test.ts        [MODIFY — Tasks 1, 4]
└── main/
    └── rpc-router.ts                            [MODIFY — Task 6] 1-line coalescer flush in pty.snapshot (line 995)
```

New `lib/` files are justified: `scratch-tabs.ts` has three consumers (PaneShell, the GC hook, tests) and must not live in 629-line PaneShell.tsx; `prompt-watcher.ts` keeps the GC hook from importing a React feature hook (lib→lib import only, mirroring the existing `use-terminal-cache-gc` → `terminal-cache` precedent). Both follow the established `pty-data-bus.ts` singleton shape including the `__reset*` test helper.

**Gate (run from `/Users/aisigma/projects/SigmaLink/app`, after every task and at the end):**
`npx tsc -b` · `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run product:check`
**NO local e2e** (`npx playwright test` launches competing Electron windows — CI's e2e-matrix runs it on the PR). Behaviors only CI e2e / the operator can verify: real WebGL context counts staying ≤ visible panes (Task 3), no ghost/dup text on real resize after Task 3 (preserves PR #133 fixes), real scratch shell surviving a workspace round-trip with live output (Task 1), real link clicks routing to the CURRENT workspace browser after a workspace switch (Task 5).

---

### Task 1: Scratch-shell tabs — module-scope store, cache destroy on close, GC reaping (Finding 1, HIGH)

**Files:**
- Create: `app/src/renderer/lib/scratch-tabs.ts`
- Create: `app/src/renderer/lib/scratch-tabs.test.ts`
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx:15,38,140-217` (imports, scratch state block)
- Modify: `app/src/renderer/features/command-room/PaneShell.test.tsx` (add terminal-cache mock + store reset + 2 new tests)
- Modify: `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts:17-51`
- Test: `app/src/renderer/lib/scratch-tabs.test.ts`, `app/src/renderer/features/command-room/PaneShell.test.tsx`, `app/src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`

Design (decided after reading the code — see Architecture): scratch tabs survive remounts via a module-scope store keyed by parent sessionId. `closeScratchTab` is the SINGLE place that kills the PTY AND destroys the cached xterm (fixes 1c). The GC hook reaps all scratch tabs whose parent session vanished from state (fixes 1a orphans + 1b pane-close, for all three REMOVE_SESSION dispatch sites at once). `activeTabId` stays per-mount React state — resetting to the main tab on remount is acceptable UX; the tabs and their scrollback are what must survive. CommandRoom.tsx is deliberately NOT modified.

- [ ] **Step 1: Write the failing store test**

Create `app/src/renderer/lib/scratch-tabs.test.ts`:

```ts
// @vitest-environment jsdom
//
// 2026-06-10 lifecycle audit, finding 1 — module-scope scratch-tab store.
//
// Contract:
//   • Tabs are keyed by parent sessionId and survive React unmounts (the
//     store is a module singleton, like terminal-cache / pty-data-bus).
//   • closeScratchTab is the SINGLE teardown choke point: it removes the
//     tab, destroys the cached xterm (terminal-cache destroy), and kills
//     the PTY (rpc.pty.killScratch) — in that order, idempotently.
//   • getScratchTabs returns a STABLE reference between mutations so it
//     is safe as a useSyncExternalStore snapshot.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const killScratchMock = vi.fn(() => Promise.resolve());
const destroyMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { pty: { killScratch: (...a: unknown[]) => killScratchMock(...a) } },
}));
vi.mock('@/renderer/lib/terminal-cache', () => ({
  destroy: (...a: unknown[]) => destroyMock(...a),
}));

import {
  addScratchTab,
  closeScratchForParent,
  closeScratchTab,
  getScratchParentIds,
  getScratchTabs,
  subscribeScratchTabs,
  __resetScratchTabs,
} from './scratch-tabs';

beforeEach(() => {
  killScratchMock.mockClear();
  destroyMock.mockClear();
  __resetScratchTabs();
});

describe('scratch-tabs store', () => {
  it('adds tabs under a parent and lists them in order', () => {
    addScratchTab('parent-1', 'scr-a');
    addScratchTab('parent-1', 'scr-b');
    expect(getScratchTabs('parent-1')).toEqual([
      { scratchId: 'scr-a' },
      { scratchId: 'scr-b' },
    ]);
    expect(getScratchTabs('parent-2')).toEqual([]);
  });

  it('returns a stable snapshot reference between mutations (useSyncExternalStore contract)', () => {
    addScratchTab('parent-1', 'scr-a');
    const first = getScratchTabs('parent-1');
    expect(getScratchTabs('parent-1')).toBe(first);
    // Unknown parents share ONE stable empty array.
    expect(getScratchTabs('nope-1')).toBe(getScratchTabs('nope-2'));
  });

  it('notifies subscribers on add and close, and unsubscribe stops notifications', () => {
    const cb = vi.fn();
    const off = subscribeScratchTabs('parent-1', cb);
    addScratchTab('parent-1', 'scr-a');
    expect(cb).toHaveBeenCalledTimes(1);
    closeScratchTab('parent-1', 'scr-a');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    addScratchTab('parent-1', 'scr-b');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('closeScratchTab destroys the cached xterm AND kills the PTY (finding 1c)', () => {
    addScratchTab('parent-1', 'scr-a');
    closeScratchTab('parent-1', 'scr-a');
    expect(getScratchTabs('parent-1')).toEqual([]);
    expect(destroyMock).toHaveBeenCalledWith('scr-a');
    expect(killScratchMock).toHaveBeenCalledWith({ scratchId: 'scr-a' });
  });

  it('closeScratchTab is a no-op for an unknown scratchId (idempotent)', () => {
    addScratchTab('parent-1', 'scr-a');
    closeScratchTab('parent-1', 'scr-zzz');
    closeScratchTab('parent-other', 'scr-a');
    expect(destroyMock).not.toHaveBeenCalled();
    expect(killScratchMock).not.toHaveBeenCalled();
    expect(getScratchTabs('parent-1')).toHaveLength(1);
  });

  it('closeScratchForParent tears down every tab and forgets the parent', () => {
    addScratchTab('parent-1', 'scr-a');
    addScratchTab('parent-1', 'scr-b');
    addScratchTab('parent-2', 'scr-c');
    closeScratchForParent('parent-1');
    expect(getScratchTabs('parent-1')).toEqual([]);
    expect(destroyMock.mock.calls.map((c) => c[0])).toEqual(['scr-a', 'scr-b']);
    expect(killScratchMock).toHaveBeenCalledTimes(2);
    expect(getScratchParentIds()).toEqual(['parent-2']);
  });

  it('closeScratchForParent is a no-op for a parent with no tabs', () => {
    expect(() => closeScratchForParent('ghost')).not.toThrow();
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the store test to verify it fails**

Run: `npx vitest run src/renderer/lib/scratch-tabs.test.ts`
Expected: FAIL — `Cannot find module './scratch-tabs'` (module does not exist yet).

- [ ] **Step 3: Implement the store**

Create `app/src/renderer/lib/scratch-tabs.ts`:

```ts
// 2026-06-10 lifecycle audit, finding 1 — module-scope scratch-tab registry.
//
// W-4 Phase 4 put scratch-shell sub-tab state in a per-mount useState inside
// PaneShell. Every room/workspace switch unmounted PaneShell and reset that
// state, orphaning the scratch PTY in main (no UI handle) and leaking its
// cached xterm + pty-bus subscription until 32-entry LRU eviction.
//
// This store is the same module-singleton pattern as terminal-cache.ts and
// pty-data-bus.ts (hasPtyDataArrived): scratch tabs are keyed by their PARENT
// sessionId and survive React unmounts, consistent with the terminal-
// multiplexer mental model (the main terminal survives a switch; the scratch
// shell next to it must too).
//
// Teardown choke point: closeScratchTab() removes the tab, destroys the
// cached xterm (so the terminal-cache entry + bus subscription + renderer
// resources go with it — finding 1c), and kills the PTY in main. Parent-level
// cleanup (pane close / relaunch / exited-grace GC — all three REMOVE_SESSION
// dispatch sites) funnels through use-terminal-cache-gc → closeScratchForParent.

import { rpc } from '@/renderer/lib/rpc';
import { destroy as destroyCachedTerminal } from '@/renderer/lib/terminal-cache';

export interface ScratchTab {
  scratchId: string;
}

const tabsByParent = new Map<string, ScratchTab[]>();
const listenersByParent = new Map<string, Set<() => void>>();
// One stable empty array so useSyncExternalStore snapshots don't loop on a
// fresh [] identity every render for parents with no tabs.
const EMPTY_TABS: ScratchTab[] = [];

function notify(parentId: string): void {
  const set = listenersByParent.get(parentId);
  if (!set) return;
  // Snapshot before dispatch — a subscriber may synchronously unsubscribe.
  for (const fn of Array.from(set)) fn();
}

/** Current scratch tabs for a parent session. Stable reference between mutations. */
export function getScratchTabs(parentId: string): ScratchTab[] {
  return tabsByParent.get(parentId) ?? EMPTY_TABS;
}

/** Subscribe to tab-list changes for one parent. Returns an unsubscribe fn. */
export function subscribeScratchTabs(parentId: string, fn: () => void): () => void {
  let set = listenersByParent.get(parentId);
  if (!set) {
    set = new Set();
    listenersByParent.set(parentId, set);
  }
  set.add(fn);
  return () => {
    const cur = listenersByParent.get(parentId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listenersByParent.delete(parentId);
  };
}

/** Register a freshly spawned scratch PTY under its parent session. */
export function addScratchTab(parentId: string, scratchId: string): void {
  tabsByParent.set(parentId, [...getScratchTabs(parentId), { scratchId }]);
  notify(parentId);
}

/**
 * Close one scratch tab: remove from the store, destroy the cached xterm
 * (terminal-cache entry + pty-bus subscription), kill the PTY in main.
 * Idempotent — unknown ids are a no-op.
 */
export function closeScratchTab(parentId: string, scratchId: string): void {
  const cur = tabsByParent.get(parentId);
  if (!cur || !cur.some((t) => t.scratchId === scratchId)) return;
  const next = cur.filter((t) => t.scratchId !== scratchId);
  if (next.length === 0) tabsByParent.delete(parentId);
  else tabsByParent.set(parentId, next);
  destroyCachedTerminal(scratchId);
  void rpc.pty.killScratch({ scratchId }).catch(() => undefined);
  notify(parentId);
}

/** Close every scratch tab of a parent (parent session removed from state). */
export function closeScratchForParent(parentId: string): void {
  const cur = tabsByParent.get(parentId);
  if (!cur) return;
  for (const tab of [...cur]) closeScratchTab(parentId, tab.scratchId);
}

/** Parents that currently own scratch tabs (GC orphan sweep). */
export function getScratchParentIds(): string[] {
  return Array.from(tabsByParent.keys());
}

/** Test-only: wipe all store state (does NOT kill PTYs / destroy terminals). */
export function __resetScratchTabs(): void {
  tabsByParent.clear();
  listenersByParent.clear();
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `npx vitest run src/renderer/lib/scratch-tabs.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/scratch-tabs.ts src/renderer/lib/scratch-tabs.test.ts
git commit -m "fix(panes): add module-scope scratch-tab store keyed by parent session"
```

- [ ] **Step 6: Write the failing PaneShell tests**

In `app/src/renderer/features/command-room/PaneShell.test.tsx`, add a terminal-cache mock next to the existing rpc mock (the real `scratch-tabs.ts` imports it; mocking keeps `@xterm/xterm` out of this jsdom suite):

```ts
// 2026-06-10 finding 1 — the real scratch-tabs store runs in these tests; it
// imports terminal-cache (destroy) which we stub so xterm never loads here.
const destroyTerminalMock = vi.fn();
vi.mock('@/renderer/lib/terminal-cache', () => ({
  destroy: (...args: unknown[]) => destroyTerminalMock(...args),
}));
```

At the END of the existing `beforeEach` (after the `window.sigma` stub), reset the module store:

```ts
  // 2026-06-10 finding 1 — the scratch store is a module singleton; reset it
  // so tabs from a previous test never leak into the next one.
  void import('@/renderer/lib/scratch-tabs').then((m) => m.__resetScratchTabs());
```

Make `beforeEach` async and await instead (cleaner — replace the line above with):

```ts
beforeEach(async () => {
  // …existing body unchanged…
  const scratchStore = await import('@/renderer/lib/scratch-tabs');
  scratchStore.__resetScratchTabs();
});
```

Also add `destroyTerminalMock.mockReset();` alongside the other `mockReset()` calls in `beforeEach`.

Append a new describe block after the existing tab-switching block:

```tsx
// ---------------------------------------------------------------------------
// 8. 2026-06-10 finding 1 — scratch lifecycle: remount survival + cache destroy
// ---------------------------------------------------------------------------
describe('PaneShell — scratch tab lifecycle (2026-06-10 finding 1)', () => {
  it('scratch tabs survive an unmount/remount cycle (room/workspace switch)', async () => {
    const first = await renderPaneShell();
    const paneContainer = first.container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();

    // Simulate a room/workspace switch: full unmount, then a fresh mount.
    first.unmount();
    await renderPaneShell();

    // The tab strip and the scratch terminal are back WITHOUT a new spawn.
    expect(screen.queryByTestId('pane-tab-strip')).toBeTruthy();
    expect(screen.queryByTestId('terminal-scratch-1')).toBeTruthy();
    expect(spawnScratchMock).toHaveBeenCalledTimes(1);
  });

  it('closing a scratch tab destroys its cached terminal (finding 1c)', async () => {
    const { container } = await renderPaneShell();
    const paneContainer = container.firstElementChild as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(paneContainer, { key: 't', metaKey: true, bubbles: true });
      await Promise.resolve();
    });
    const closeBtn = screen.getByLabelText('Close scratch 1');
    await act(async () => {
      fireEvent.click(closeBtn);
      await Promise.resolve();
    });
    expect(destroyTerminalMock).toHaveBeenCalledWith('scratch-1');
    expect(killScratchMock).toHaveBeenCalledWith({ scratchId: 'scratch-1' });
  });
});
```

- [ ] **Step 7: Run PaneShell tests to verify the new ones fail**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx`
Expected: FAIL — "scratch tabs survive an unmount/remount cycle" fails (`pane-tab-strip` is null after remount: per-mount useState reset) and "destroys its cached terminal" fails (`destroyTerminalMock` never called). All pre-existing tests still PASS.

- [ ] **Step 8: Rewire PaneShell onto the store**

In `app/src/renderer/features/command-room/PaneShell.tsx`:

(a) Change the React import (line 15) to include `useSyncExternalStore`:

```tsx
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
```

(b) Change the PaneTabStrip import (line 38) — `ScratchTab` now comes from the store; PaneTabStrip's local interface stays (structurally identical):

```tsx
import { PaneTabStrip } from './PaneTabStrip';
import {
  addScratchTab,
  closeScratchTab,
  getScratchTabs,
  subscribeScratchTabs,
} from '@/renderer/lib/scratch-tabs';
```

(c) Replace the scratch state block (lines 140-186: the `scratchTabs` useState, `activeTabId` useState, `activeTabIdRef`, `spawnScratch`, `closeScratch`) with:

```tsx
  // W-4 Phase 4 + 2026-06-10 finding 1 — scratch tabs live in a MODULE-SCOPE
  // store keyed by this pane's sessionId, so they survive room/workspace
  // switches exactly like the cached terminal does. Only the active-tab
  // SELECTION is per-mount (a remount lands back on the main tab — fine).
  // INVARIANT: with zero scratch tabs, no tab-strip renders and the pane body
  // is byte-for-byte identical to the pre-Phase-4 render.
  const scratchSubscribe = useCallback(
    (cb: () => void) => subscribeScratchTabs(session.id, cb),
    [session.id],
  );
  const scratchSnapshot = useCallback(() => getScratchTabs(session.id), [session.id]);
  const scratchTabs = useSyncExternalStore(scratchSubscribe, scratchSnapshot);
  const [activeTabId, setActiveTabId] = useState<string>(session.id);
  // Ref used by the keydown handler to check if THIS pane container is focused.
  const paneContainerRef = useRef<HTMLDivElement>(null);

  // Keep activeTabId readable from stable callbacks without re-subscribing.
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Spawn a scratch shell PTY and register its tab in the module store.
  const spawnScratch = useCallback(async () => {
    const cwd = session.worktreePath ?? '.';
    try {
      const result = await rpc.pty.spawnScratch({ cwd });
      addScratchTab(session.id, result.scratchId);
      setActiveTabId(result.scratchId);
    } catch {
      // Silent — toast from the rpc layer if applicable.
    }
  }, [session.id, session.worktreePath]);

  // Close a scratch tab. The store kills the PTY AND destroys the cached
  // xterm (finding 1c); we only manage the local active-tab selection here.
  const closeScratch = useCallback(
    (scratchId: string) => {
      const tabs = getScratchTabs(session.id);
      if (activeTabIdRef.current === scratchId) {
        const idx = tabs.findIndex((t) => t.scratchId === scratchId);
        const remaining = tabs.filter((t) => t.scratchId !== scratchId);
        const next = remaining[idx] ?? remaining[idx - 1] ?? null;
        setActiveTabId(next ? next.scratchId : session.id);
      }
      closeScratchTab(session.id, scratchId);
    },
    [session.id],
  );
```

No other PaneShell changes — the `scratchTabs.length` render branches (lines 433-441, 485-514) consume the same `ScratchTab[]` shape unchanged. Net effect: the file SHRINKS by a few lines.

- [ ] **Step 9: Run PaneShell tests to verify all pass**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx`
Expected: PASS (all pre-existing scratch/crash/skill/context-menu tests + the 2 new ones).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/features/command-room/PaneShell.tsx src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "fix(panes): scratch tabs ride the module store — survive remounts, destroy cached xterm on close"
```

- [ ] **Step 11: Write the failing GC tests**

In `app/src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`, add mocks below the existing terminal-cache mock:

```ts
const closeScratchForParentMock = vi.fn();
let scratchParentIds: string[] = [];
vi.mock('@/renderer/lib/scratch-tabs', () => ({
  closeScratchForParent: (...args: unknown[]) => closeScratchForParentMock(...args),
  getScratchParentIds: () => scratchParentIds,
}));
```

In `beforeEach`, add:

```ts
  closeScratchForParentMock.mockReset();
  scratchParentIds = [];
```

Append a new describe block:

```ts
describe('useTerminalCacheGc — scratch reaping (2026-06-10 finding 1)', () => {
  it('closes scratch tabs of a session that disappears from state', () => {
    const { rerender } = renderHook(({ s }: { s: AppState }) => useTerminalCacheGc(s), {
      initialProps: { s: stateWith({ 'ws-1': [session('s1'), session('s2')] }) },
    });
    rerender({ s: stateWith({ 'ws-1': [session('s1')] }) });
    expect(closeScratchForParentMock).toHaveBeenCalledWith('s2');
    expect(closeScratchForParentMock).not.toHaveBeenCalledWith('s1');
  });

  it('sweeps scratch parents that never appeared in state (orphan defence)', () => {
    scratchParentIds = ['ghost-parent'];
    renderHook(() => useTerminalCacheGc(stateWith({ 'ws-1': [session('s1')] })));
    expect(closeScratchForParentMock).toHaveBeenCalledWith('ghost-parent');
  });

  it('does not close scratch tabs for sessions still present in any workspace', () => {
    scratchParentIds = ['s1'];
    renderHook(() => useTerminalCacheGc(stateWith({ 'ws-1': [session('s1')] })));
    expect(closeScratchForParentMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 12: Run GC tests to verify the new ones fail**

Run: `npx vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`
Expected: FAIL — `closeScratchForParentMock` never called (hook doesn't import the store yet). Pre-existing 4 tests PASS.

- [ ] **Step 13: Implement GC scratch reaping**

In `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts`, add the import and extend the effect. Full new file body below the header comment (replace lines 17-52):

```ts
import { useEffect, useRef } from 'react';
import type { AppState } from '../state.types';
import { destroy, hasCached } from '@/renderer/lib/terminal-cache';
import { closeScratchForParent, getScratchParentIds } from '@/renderer/lib/scratch-tabs';

export function useTerminalCacheGc(state: AppState): void {
  // Track every sessionId we've seen so a one-shot vanishing (session was
  // present in a previous render, gone in the current one) triggers a
  // cache destroy. Set-of-strings instead of comparing arrays so we don't
  // pay an O(n^2) diff cost on workspaces with many panes.
  const everSeen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const seenNow = new Set<string>();
    // Walk every per-workspace session list. The flat `state.sessions`
    // array exists too, but the per-workspace map is the source of truth
    // GridLayout / SessionTerminal subscribe to.
    for (const list of Object.values(state.sessionsByWorkspace)) {
      for (const session of list) seenNow.add(session.id);
    }
    for (const session of state.sessions) seenNow.add(session.id);

    // Anything in everSeen but not in seenNow disappeared this tick;
    // dispose its cache entry (if any) AND its scratch sub-tabs — this is
    // the single choke point that sees all three REMOVE_SESSION dispatch
    // sites (explicit close, relaunch, exited-grace GC). 2026-06-10
    // finding 1: scratch ids never appear in state, so they must be reaped
    // via their PARENT id here.
    for (const id of everSeen.current) {
      if (seenNow.has(id)) continue;
      if (hasCached(id)) destroy(id);
      closeScratchForParent(id);
    }
    // Defence in depth: scratch parents the store knows about that are not
    // in state at all (e.g. state slices replaced wholesale) get swept too.
    for (const parentId of getScratchParentIds()) {
      if (!seenNow.has(parentId)) closeScratchForParent(parentId);
    }
    // Persist the merged set for next-tick diff. We only ADD here; once
    // a session id has appeared once we keep tracking it until it's gone.
    for (const id of seenNow) everSeen.current.add(id);
    // Prune ids that are gone from both seenNow and the cache — they've
    // already been GC'd in a prior tick and no longer need tracking.
    for (const id of Array.from(everSeen.current)) {
      if (!seenNow.has(id) && !hasCached(id)) everSeen.current.delete(id);
    }
  }, [state.sessionsByWorkspace, state.sessions]);
}
```

- [ ] **Step 14: Run GC tests to verify all pass**

Run: `npx vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`
Expected: PASS (7 tests). Note: the pre-existing "destroys cache entries for sessions that disappear" test now ALSO sees `closeScratchForParent('s2')` — that is correct behavior, the test's assertions are unaffected.

- [ ] **Step 15: Commit**

```bash
git add src/renderer/app/state-hooks/use-terminal-cache-gc.ts src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts
git commit -m "fix(panes): GC reaps scratch PTYs + cached xterms when the parent session vanishes"
```

---

### Task 2: LRU eviction must never destroy a terminal attached to a real host (Finding 2, LOW)

**Files:**
- Modify: `app/src/renderer/lib/terminal-cache.ts:198-216` (`evictOldestIfFull`)
- Test: `app/src/renderer/lib/terminal-cache.test.ts`

An entry whose xterm root is parented by a REAL host (not the parking lot) is on-screen; evicting it blanks a visible pane and `Terminal.tsx:155` swallows the follow-up fit throw. Guard: only parked entries are eviction candidates. If every entry is attached (pathological — would need >32 simultaneously mounted panes), the cache temporarily exceeds the cap, which is bounded by the number of mounted panes and strictly better than blanking one.

- [ ] **Step 1: Write the failing test**

Append to `app/src/renderer/lib/terminal-cache.test.ts`:

```ts
// ── 2026-06-10 finding 2 — LRU eviction must skip host-attached terminals ───
describe('terminal-cache — eviction guard (2026-06-10 finding 2)', () => {
  it('never evicts an entry attached to a real host, even when it is the LRU', async () => {
    const { getOrCreateTerminal, attachToHost, hasCached, TERMINAL_CACHE_LIMIT } =
      await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);

    // Deterministic lastAccessed ordering: advance the clock 1ms per entry.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const entries = [];
      for (let i = 0; i < TERMINAL_CACHE_LIMIT; i++) {
        entries.push(getOrCreateTerminal(`evict-${i}`, ctx));
        vi.setSystemTime(1_000_000 + (i + 1) * 1000);
      }
      // evict-0 is the LRU — but it is ON-SCREEN (attached to a real host).
      // attachToHost bumps lastAccessed, so re-pin it as oldest afterwards.
      attachToHost(entries[0]!, host);
      entries[0]!.lastAccessed = 0;

      // 33rd entry forces an eviction.
      getOrCreateTerminal('evict-overflow', ctx);

      // The attached LRU survives; the oldest PARKED entry (evict-1) died.
      expect(hasCached('evict-0')).toBe(true);
      expect(hasCached('evict-1')).toBe(false);
      expect(hasCached('evict-overflow')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exceeds the cap rather than evict when every entry is attached', async () => {
    const { getOrCreateTerminal, attachToHost, getCacheSize, TERMINAL_CACHE_LIMIT } =
      await import('./terminal-cache');
    for (let i = 0; i < TERMINAL_CACHE_LIMIT; i++) {
      const entry = getOrCreateTerminal(`pin-${i}`, ctx);
      const host = document.createElement('div');
      document.body.appendChild(host);
      attachToHost(entry, host);
    }
    getOrCreateTerminal('pin-overflow', ctx);
    // Nothing was destroyable — the cache grows past the cap (bounded by
    // the number of mounted panes), instead of blanking a visible pane.
    expect(getCacheSize()).toBe(TERMINAL_CACHE_LIMIT + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: FAIL — first test: `hasCached('evict-0')` is `false` (the attached LRU was destroyed); second test: `getCacheSize()` is `TERMINAL_CACHE_LIMIT` (an attached entry was evicted). All pre-existing tests PASS.

- [ ] **Step 3: Implement the guard**

In `app/src/renderer/lib/terminal-cache.ts`, add above `evictOldestIfFull` and replace the function (lines 198-216):

```ts
/**
 * 2026-06-10 finding 2 — an entry is "parked" when its xterm DOM root is in
 * the offscreen parking lot (or was never attached anywhere). Entries whose
 * root is parented by a REAL host are on-screen right now; destroying one
 * blanks a visible pane (Terminal.tsx's runFit try/catch then swallows every
 * subsequent fit). Only parked entries are eviction candidates.
 */
function isParked(entry: CacheEntry): boolean {
  const root = entry.terminal.element;
  if (!root || !root.parentNode) return true;
  return parkingLot !== null && root.parentNode === parkingLot;
}

function evictOldestIfFull(): void {
  if (cache.size < TERMINAL_CACHE_LIMIT) return;
  // Prefer evicting entries whose PTY has already exited (they're effectively
  // read-only scrollback at this point); only then fall back to plain LRU
  // among live sessions. 2026-06-10 finding 2: NEVER evict an entry attached
  // to a real host — if every entry is attached (pathological: >cap mounted
  // panes) we exceed the cap instead, which is bounded by mounted-pane count.
  let exitedVictim: CacheEntry | null = null;
  let liveVictim: CacheEntry | null = null;
  for (const entry of cache.values()) {
    if (!isParked(entry)) continue;
    if (entry.ptyExited) {
      if (!exitedVictim || entry.lastAccessed < exitedVictim.lastAccessed) {
        exitedVictim = entry;
      }
    } else if (!liveVictim || entry.lastAccessed < liveVictim.lastAccessed) {
      liveVictim = entry;
    }
  }
  const victim = exitedVictim ?? liveVictim;
  if (victim) destroy(victim.sessionId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/terminal-cache.ts src/renderer/lib/terminal-cache.test.ts
git commit -m "fix(panes): LRU eviction skips host-attached terminals — never blank a visible pane"
```

---

### Task 3: Load WebGL on attach, dispose on detach — contexts ≈ visible panes (Finding 3, MED perf)

**Files:**
- Modify: `app/src/renderer/lib/terminal-cache.ts:105-127` (CacheEntry), `:235-276` (creation path), `:368-390` (attach/detach)
- Test: `app/src/renderer/lib/terminal-cache.test.ts`

Today every cached entry (cap 32) holds a WebGL context vs Chromium's ~16-per-process cap, so PARKED terminals can evict the context of a VISIBLE pane (silent downgrade to the slow DOM renderer). Parked terminals only need buffer parsing — no GPU renderer. Move the addon to attach/detach; keep the `onContextLoss` → dispose self-heal (xterm auto-reverts to the DOM renderer, never a blank pane).

**CAUTION (PR #133 / pane-resize fixes):** the resize correctness fixes live in `Terminal.tsx` (`fit.fit()` atomic refit, `sigma:pane-resize-start/-end` drag suppression) — this task does NOT touch that file. Inside `terminal-cache.ts`, preserve: addon loaded only AFTER `term.open()` (attach always happens post-open), the `onContextLoss` self-heal, and the fact that the canvas lives inside `term.element` so it survives DOM moves. Update the explanatory comment rather than deleting it. The renderer-downgrade/context-count behavior itself is only verifiable by CI e2e / operator smoke (jsdom has no GPU) — the unit tests assert the load/dispose lifecycle only.

- [ ] **Step 1: Add a WebglAddon mock + failing tests**

In `app/src/renderer/lib/terminal-cache.test.ts`, add below the `@xterm/addon-web-links` mock:

```ts
// 2026-06-10 finding 3 — observable WebGL addon lifecycle. The real addon
// needs a GPU context; this mock records construction/dispose so tests can
// assert "contexts ≈ visible panes".
interface MockWebgl {
  dispose: ReturnType<typeof vi.fn>;
  onContextLoss: ReturnType<typeof vi.fn>;
}
const createdWebgls: MockWebgl[] = [];
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose = vi.fn();
    onContextLoss = vi.fn();
    constructor() {
      createdWebgls.push(this as unknown as MockWebgl);
    }
  },
}));
```

In `beforeEach`, add `createdWebgls.length = 0;` next to `createdTerms.length = 0;`.

Append the tests:

```ts
// ── 2026-06-10 finding 3 — WebGL renderer only while attached to a host ─────
describe('terminal-cache — WebGL attach/detach lifecycle (2026-06-10 finding 3)', () => {
  it('does NOT load the WebGL addon at creation (parked terminals parse buffers only)', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    getOrCreateTerminal('webgl-1', ctx);
    expect(createdWebgls.length).toBe(0);
  });

  it('loads WebGL on attachToHost and disposes it on detachFromHost', async () => {
    const { getOrCreateTerminal, attachToHost, detachFromHost } =
      await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);

    const entry = getOrCreateTerminal('webgl-2', ctx);
    attachToHost(entry, host);
    expect(createdWebgls.length).toBe(1);
    // Registered the context-loss self-heal before loading.
    expect(createdWebgls[0]!.onContextLoss).toHaveBeenCalledTimes(1);

    detachFromHost(entry);
    expect(createdWebgls[0]!.dispose).toHaveBeenCalledTimes(1);

    // Re-attach builds a FRESH addon (contexts track visible panes).
    attachToHost(entry, host);
    expect(createdWebgls.length).toBe(2);
  });

  it('attachToHost is idempotent — re-attaching to the same host loads no second addon', async () => {
    const { getOrCreateTerminal, attachToHost } = await import('./terminal-cache');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const entry = getOrCreateTerminal('webgl-3', ctx);
    attachToHost(entry, host);
    attachToHost(entry, host);
    expect(createdWebgls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: FAIL — first test: `createdWebgls.length` is 1 (loaded at creation today); second test: dispose never called on detach. (Pre-existing tests keep passing — with the mock in place, creation-time load succeeds silently and nothing asserts on it.)

- [ ] **Step 3: Implement attach/detach WebGL ownership**

In `app/src/renderer/lib/terminal-cache.ts`:

(a) Add to `CacheEntry` (after `snapshotReady`, line ~126):

```ts
  /** 2026-06-10 finding 3 — WebGL addon held ONLY while attached to a real
   *  host, so live GPU contexts ≈ visible panes instead of ≈ cache size
   *  (Chromium caps ~16 WebGL contexts per process; the cache holds 32).
   *  Null while parked (the DOM-renderer-free buffer still parses bytes). */
  webglAddon: WebglAddon | null;
```

(b) DELETE the creation-time WebGL block (lines 250-276: the `// Renderer: load the WebGL renderer…` comment + `try { const webgl = new WebglAddon(); … } catch { … }`) and initialise the field in the entry literal (after `snapshotReady: false,`):

```ts
    webglAddon: null,
```

(c) Add a loader above `attachToHost` and replace `attachToHost`/`detachFromHost` (lines 368-390):

```ts
/**
 * 2026-06-10 finding 3 — WebGL renderer is an ATTACHED-ONLY concern. xterm 6's
 * default DOM renderer rebuilds per-row DOM on every resize repaint (the
 * pane-resize "glitch"), so visible panes want WebGL; parked terminals only
 * parse bytes into the buffer and need no renderer at all. Loading here (and
 * disposing in detachFromHost) keeps live GPU contexts ≈ visible panes,
 * under Chromium's ~16-context cap.
 *
 * Best-effort + self-healing (unchanged from the creation-time version): if
 * WebGL is unavailable (jsdom, GPU blocklist) the load throws and the DOM
 * renderer stays; if Chromium evicts the context, `onContextLoss` disposes
 * the addon and xterm reverts to the DOM renderer — never a blank pane. Must
 * run AFTER term.open(), which always happened at creation (parking-lot open).
 */
function loadWebglAddon(entry: CacheEntry): void {
  if (entry.webglAddon) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch {
        /* already disposed — ignore */
      }
      if (entry.webglAddon === webgl) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(webgl);
    entry.webglAddon = webgl;
  } catch {
    /* WebGL unavailable — xterm's default DOM renderer remains active */
  }
}

/**
 * Move the xterm DOM root from wherever it currently lives (parking lot
 * or previous host) into the provided container, and bring up the WebGL
 * renderer for the now-visible terminal. Idempotent — safe to call when
 * the terminal is already mounted in `host`.
 */
export function attachToHost(entry: CacheEntry, host: HTMLElement): void {
  const root = entry.terminal.element;
  if (!root) return;
  if (root.parentNode !== host) host.appendChild(root);
  entry.lastAccessed = Date.now();
  loadWebglAddon(entry);
}

/**
 * Park the xterm DOM root in the offscreen container without disposing
 * the terminal, and release the WebGL context (finding 3) — a parked
 * terminal only needs buffer parsing. Resize observers / focus listeners
 * that the host wired are NOT removed here — they belong to the host's
 * React mount and are torn down by the host's cleanup.
 */
export function detachFromHost(entry: CacheEntry): void {
  const root = entry.terminal.element;
  if (!root) return;
  const parking = ensureParkingLot();
  if (root.parentNode !== parking) parking.appendChild(root);
  if (entry.webglAddon) {
    try {
      entry.webglAddon.dispose();
    } catch {
      /* already disposed (e.g. context loss raced) — ignore */
    }
    entry.webglAddon = null;
  }
}
```

(`destroy()` needs no change: `terminal.dispose()` cascades to loaded addons; the entry is dropped from the cache either way.)

- [ ] **Step 4: Run the full terminal-cache suite**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: PASS — including the Task 2 eviction tests (attachToHost still bumps `lastAccessed`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/terminal-cache.ts src/renderer/lib/terminal-cache.test.ts
git commit -m "fix(panes): load WebGL on attach / dispose on detach — GPU contexts track visible panes"
```

---

### Task 4: SIGMA::PROMPT survives remounts via a module-scope watcher (Finding 4, MED)

**Files:**
- Create: `app/src/renderer/lib/prompt-watcher.ts`
- Create: `app/src/renderer/lib/prompt-watcher.test.ts`
- Modify: `app/src/renderer/features/command-room/use-prompt-card.ts:25-112`
- Modify: `app/src/renderer/features/command-room/use-prompt-card.test.ts` (lifecycle contract changes + reset)
- Modify: `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts` (+ its test) — dispose watchers for vanished sessions
- Test: all three test files above

Chosen design (over snapshot-tail rescan — see Verification notes): a module-scope watcher per sessionId, installed lazily on the first enabled mount, holding the `ProtocolLineBuffer` + last valid prompt. It keeps parsing while PaneShell is unmounted (the bus subscription persists — same trick as the cache's own data subscription), so a prompt arriving mid-switch is waiting when the pane remounts. `answer`/`dismiss` clear the module state. The GC disposes watchers when the session vanishes. **Contract change:** `usePromptCard` no longer unsubscribes the bus on unmount — two existing lifecycle tests are updated to assert the NEW contract. Residual limitation (acceptable, document only): a prompt emitted before the FIRST-ever enabled mount of a session is still missed (the bus has no replay); the watcher closes the remount gap, which is the reported bug.

- [ ] **Step 1: Write the failing watcher test**

Create `app/src/renderer/lib/prompt-watcher.test.ts`:

```ts
// @vitest-environment jsdom
//
// 2026-06-10 finding 4 — module-scope SIGMA::PROMPT watcher.
//
// The bus has no replay, so a watcher that only lives while PaneShell is
// mounted loses prompt lines arriving during a room/workspace switch. This
// watcher persists at module scope (the hasPtyDataArrived pattern): once
// installed for a session it keeps parsing while NO component is mounted,
// and the last valid prompt is waiting at the next mount.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (p: { sessionId: string; data: string }) => void;
const busSubscribers = new Map<string, Set<Listener>>();
const busUnsubscribeSpy = vi.fn();

vi.mock('@/renderer/lib/pty-data-bus', () => ({
  subscribePtyData: (sessionId: string, fn: Listener) => {
    let set = busSubscribers.get(sessionId);
    if (!set) {
      set = new Set();
      busSubscribers.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      busUnsubscribeSpy(sessionId);
      busSubscribers.get(sessionId)?.delete(fn);
    };
  },
}));

import {
  clearActivePrompt,
  disposePromptWatcher,
  ensurePromptWatcher,
  getActivePrompt,
  subscribeActivePrompt,
  __resetPromptWatchers,
} from './prompt-watcher';

function emit(sessionId: string, data: string): void {
  busSubscribers.get(sessionId)?.forEach((fn) => fn({ sessionId, data }));
}

const VALID =
  'SIGMA::PROMPT {"question":"Pick one","type":"single","choices":["red","blue"]}\n';

beforeEach(() => {
  __resetPromptWatchers();
  busSubscribers.clear();
  busUnsubscribeSpy.mockClear();
});

describe('prompt-watcher', () => {
  it('captures a prompt with NO component subscriber attached (the remount-gap bug)', () => {
    ensurePromptWatcher('s1');
    emit('s1', VALID); // arrives while the pane is unmounted
    expect(getActivePrompt('s1')).toMatchObject({
      question: 'Pick one',
      type: 'single',
      choices: ['red', 'blue'],
    });
  });

  it('re-buffers a prompt split across coalesced chunks', () => {
    ensurePromptWatcher('s1');
    emit('s1', 'SIGMA::PROMPT {"question":"Q","type":"single",');
    expect(getActivePrompt('s1')).toBeNull();
    emit('s1', '"choices":["yes","no"]}\n');
    expect(getActivePrompt('s1')).toMatchObject({ choices: ['yes', 'no'] });
  });

  it('ignores non-PROMPT and malformed lines', () => {
    ensurePromptWatcher('s1');
    emit('s1', 'SIGMA::SAY {"body":"hi"}\n');
    emit('s1', 'just regular terminal output\n');
    emit('s1', 'SIGMA::PROMPT {bad json}\n');
    expect(getActivePrompt('s1')).toBeNull();
  });

  it('ensurePromptWatcher is idempotent — one bus subscription per session', () => {
    ensurePromptWatcher('s1');
    ensurePromptWatcher('s1');
    expect(busSubscribers.get('s1')?.size).toBe(1);
  });

  it('notifies subscribers on new prompt and on clear', () => {
    ensurePromptWatcher('s1');
    const cb = vi.fn();
    const off = subscribeActivePrompt('s1', cb);
    emit('s1', VALID);
    expect(cb).toHaveBeenCalledTimes(1);
    clearActivePrompt('s1');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getActivePrompt('s1')).toBeNull();
    off();
    emit('s1', VALID);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('disposePromptWatcher unsubscribes the bus and drops state', () => {
    ensurePromptWatcher('s1');
    emit('s1', VALID);
    disposePromptWatcher('s1');
    expect(busUnsubscribeSpy).toHaveBeenCalledWith('s1');
    expect(getActivePrompt('s1')).toBeNull();
  });

  it('disposePromptWatcher is a no-op for an unknown session', () => {
    expect(() => disposePromptWatcher('never-watched')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/prompt-watcher.test.ts`
Expected: FAIL — `Cannot find module './prompt-watcher'`.

- [ ] **Step 3: Implement the watcher**

Create `app/src/renderer/lib/prompt-watcher.ts`:

```ts
// 2026-06-10 finding 4 — module-scope SIGMA::PROMPT watcher.
//
// use-prompt-card.ts used to subscribe to the pty-data bus only while
// PaneShell was mounted; the bus has no replay (pty-data-bus.ts), so a
// prompt line arriving during a room/workspace switch was lost and the
// card never showed while the CLI blocked on stdin.
//
// This module is the hasPtyDataArrived pattern applied to prompts: once a
// session's watcher is installed (first enabled mount), its bus
// subscription + ProtocolLineBuffer persist across React unmounts, and the
// last valid prompt waits for the next mount. answer/dismiss clear it via
// clearActivePrompt; use-terminal-cache-gc disposes watchers when the
// session vanishes from state.
//
// ProtocolLineBuffer is imported from the shared protocol module — it is a
// pure module (no node/electron deps); the renderer already imports it via
// use-prompt-card.ts, so there is no bundling hazard and no drift risk.

import {
  ProtocolLineBuffer,
  isPromptPayload,
  parseProtocolLine,
  type PromptPayload,
} from '@/main/core/swarms/protocol';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';

const watchers = new Map<string, { off: () => void }>();
const activePrompts = new Map<string, PromptPayload>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const fn of Array.from(set)) fn();
}

/**
 * Install the persistent watcher for a session (idempotent). Called from
 * usePromptCard when the feature is enabled for a mounted pane; the watcher
 * then outlives the mount on purpose.
 */
export function ensurePromptWatcher(sessionId: string): void {
  if (watchers.has(sessionId)) return;
  const buf = new ProtocolLineBuffer();
  const off = subscribePtyData(sessionId, ({ data }) => {
    buf.push(data, (line) => {
      const parsed = parseProtocolLine(line);
      if (!parsed || parsed.verb !== 'PROMPT') return;
      if (!isPromptPayload(parsed.payload)) return;
      // Latest valid prompt wins — a pane asks one question at a time and a
      // newer question supersedes a stale one.
      activePrompts.set(sessionId, parsed.payload);
      notify(sessionId);
    });
  });
  watchers.set(sessionId, { off });
}

/** The pending prompt for a session, or null. */
export function getActivePrompt(sessionId: string): PromptPayload | null {
  return activePrompts.get(sessionId) ?? null;
}

/** Subscribe to active-prompt changes for one session. Returns unsubscribe. */
export function subscribeActivePrompt(sessionId: string, fn: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(sessionId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(sessionId);
  };
}

/** Clear the pending prompt (operator answered or dismissed). */
export function clearActivePrompt(sessionId: string): void {
  if (activePrompts.delete(sessionId)) notify(sessionId);
}

/** Tear down a session's watcher + state. Idempotent; called by the GC. */
export function disposePromptWatcher(sessionId: string): void {
  const w = watchers.get(sessionId);
  if (w) {
    try {
      w.off();
    } catch {
      /* bus already reset — ignore */
    }
    watchers.delete(sessionId);
  }
  if (activePrompts.delete(sessionId)) notify(sessionId);
}

/** Test-only: wipe all watcher state. */
export function __resetPromptWatchers(): void {
  for (const id of Array.from(watchers.keys())) disposePromptWatcher(id);
  activePrompts.clear();
  listeners.clear();
}
```

- [ ] **Step 4: Run watcher tests**

Run: `npx vitest run src/renderer/lib/prompt-watcher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/prompt-watcher.ts src/renderer/lib/prompt-watcher.test.ts
git commit -m "fix(panes): module-scope SIGMA::PROMPT watcher — prompt lines survive remounts"
```

- [ ] **Step 6: Update use-prompt-card tests to the new contract (failing first)**

In `app/src/renderer/features/command-room/use-prompt-card.test.ts`:

(a) In `beforeEach`, add the watcher reset (make `beforeEach` async):

```ts
beforeEach(async () => {
  ptyWriteMock.mockReset().mockResolvedValue(undefined);
  unsubscribeSpy.mockReset();
  subscribers.clear();
  const watcher = await import('@/renderer/lib/prompt-watcher');
  watcher.__resetPromptWatchers();
});
```

(b) REPLACE the entire `describe('usePromptCard — lifecycle', …)` block (the two tests asserting bus-unsubscribe-on-unmount and unsubscribe-on-disable assert the OLD, buggy contract):

```ts
describe('usePromptCard — lifecycle (2026-06-10 finding 4: watcher persists)', () => {
  it('surfaces a prompt that arrived while the pane was UNMOUNTED (the remount-gap bug)', async () => {
    const usePromptCard = await load();
    // First enabled mount installs the persistent watcher.
    const first = renderHook(() => usePromptCard('s1', true));
    expect(first.result.current.prompt).toBeNull();
    first.unmount();
    // Prompt arrives mid room/workspace switch — nobody is mounted.
    act(() => emit('s1', VALID_SINGLE));
    // Remount: the prompt is waiting.
    const second = renderHook(() => usePromptCard('s1', true));
    expect(second.result.current.prompt).toMatchObject({ question: 'Pick one' });
  });

  it('keeps the bus subscription alive across unmount (no unsubscribe)', async () => {
    const usePromptCard = await load();
    const { unmount } = renderHook(() => usePromptCard('s1', true));
    unmount();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
    expect(subscribers.get('s1')?.size).toBe(1);
  });

  it('returns null when the feature is turned off, without killing the watcher', async () => {
    const usePromptCard = await load();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePromptCard('s1', enabled),
      { initialProps: { enabled: true } },
    );
    act(() => emit('s1', VALID_SINGLE));
    expect(result.current.prompt).not.toBeNull();
    rerender({ enabled: false });
    expect(result.current.prompt).toBeNull();
  });

  it('answer() clears the prompt for EVERY consumer of the session (module state)', async () => {
    const usePromptCard = await load();
    const { result } = renderHook(() => usePromptCard('s1', true));
    act(() => emit('s1', VALID_SINGLE));
    act(() => result.current.answer(['red']));
    // The module-level prompt is gone — a remounted pane shows no stale card.
    const remounted = renderHook(() => usePromptCard('s1', true));
    expect(remounted.result.current.prompt).toBeNull();
  });
});
```

All OTHER existing describes (gating, parsing, answer & dismiss) stay byte-for-byte — they assert behavior the rewrite preserves.

- [ ] **Step 7: Run to verify the new lifecycle tests fail**

Run: `npx vitest run src/renderer/features/command-room/use-prompt-card.test.ts`
Expected: FAIL — "surfaces a prompt that arrived while the pane was UNMOUNTED" (prompt is null: today's hook unsubscribed on unmount and the line was lost) and "keeps the bus subscription alive" (unsubscribeSpy WAS called).

- [ ] **Step 8: Rewrite usePromptCard as a thin adapter**

Replace the body of `app/src/renderer/features/command-room/use-prompt-card.ts` from the import block down (keep the file-header comment, updating its third paragraph). Full new code below the header comment:

```ts
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { PromptPayload } from '@/main/core/swarms/protocol';
import {
  clearActivePrompt,
  ensurePromptWatcher,
  getActivePrompt,
  subscribeActivePrompt,
} from '@/renderer/lib/prompt-watcher';

export interface UsePromptCardResult {
  /** The active prompt, or null when none is pending. */
  prompt: PromptPayload | null;
  /**
   * Submit the operator's answer. `choices` are the chosen option text(s);
   * multi-select answers are joined by ", " and a trailing newline is appended
   * (the PTY write is raw — `rpc.pty.write` does NOT auto-newline). Clears the
   * active prompt.
   */
  answer: (choices: string[]) => void;
  /** Dismiss the active prompt without writing anything to stdin. */
  dismiss: () => void;
}

/**
 * FEAT-4 prompt-card hook. 2026-06-10 finding 4: parsing + prompt state live
 * in the module-scope prompt-watcher (installed on the first enabled mount and
 * persisting across unmounts, because the pty-data bus has no replay). This
 * hook is a thin React adapter: it ensures the watcher exists, mirrors the
 * module state via useSyncExternalStore, and writes answers back to stdin.
 */
export function usePromptCard(sessionId: string, enabled: boolean): UsePromptCardResult {
  // Keep a ref so the answer/dismiss callbacks have stable identity.
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // Install the persistent watcher on the first enabled mount. Deliberately
  // NOT torn down on unmount/disable — that persistence IS the fix; the GC
  // hook disposes it when the session leaves app state.
  useEffect(() => {
    if (!enabled) return;
    ensurePromptWatcher(sessionId);
  }, [sessionId, enabled]);

  const subscribe = useCallback(
    (cb: () => void) => subscribeActivePrompt(sessionId, cb),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getActivePrompt(sessionId), [sessionId]);
  const live = useSyncExternalStore(subscribe, getSnapshot);
  const prompt = enabled ? live : null;

  const answer = useCallback((choices: string[]) => {
    // C1 (review) — `choices` are AGENT-controlled (decoded from the SIGMA::PROMPT
    // JSON, so an escaped "\n" becomes a real newline). Strip control chars and
    // collapse newlines from each choice so a hostile choice like "yes\nrm -rf ~"
    // cannot inject a SECOND command line into the pane's stdin. The single
    // trailing '\n' we append below is the ONLY newline that reaches the CLI.
    const text = choices
      // eslint-disable-next-line no-control-regex -- stripping control chars IS the point (C1).
      .map((c) => c.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim())
      .filter((c) => c.length > 0)
      .join(', ');
    // Raw write — pty.write does not append a newline (see insertMention.ts /
    // insertSkillCommand.ts). The '\n' submits the (sanitized) answer to the CLI.
    void rpc.pty.write(sessionRef.current, `${text}\n`).catch(() => {
      /* registry swallows unknown-session writes; nothing to surface here */
    });
    clearActivePrompt(sessionRef.current);
  }, []);

  const dismiss = useCallback(() => {
    clearActivePrompt(sessionRef.current);
  }, []);

  return { prompt, answer, dismiss };
}
```

- [ ] **Step 9: Run the hook tests**

Run: `npx vitest run src/renderer/features/command-room/use-prompt-card.test.ts`
Expected: PASS (gating + parsing + answer/dismiss + new lifecycle).

- [ ] **Step 10: GC disposes watchers — failing test then implementation**

In `app/src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`, add the mock next to the scratch-tabs mock from Task 1:

```ts
const disposePromptWatcherMock = vi.fn();
vi.mock('@/renderer/lib/prompt-watcher', () => ({
  disposePromptWatcher: (...args: unknown[]) => disposePromptWatcherMock(...args),
}));
```

Add `disposePromptWatcherMock.mockReset();` to `beforeEach`, and append a test:

```ts
describe('useTerminalCacheGc — prompt-watcher reaping (2026-06-10 finding 4)', () => {
  it('disposes the prompt watcher of a session that disappears from state', () => {
    const { rerender } = renderHook(({ s }: { s: AppState }) => useTerminalCacheGc(s), {
      initialProps: { s: stateWith({ 'ws-1': [session('s1'), session('s2')] }) },
    });
    rerender({ s: stateWith({ 'ws-1': [session('s1')] }) });
    expect(disposePromptWatcherMock).toHaveBeenCalledWith('s2');
    expect(disposePromptWatcherMock).not.toHaveBeenCalledWith('s1');
  });
});
```

Run: `npx vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts` → expected FAIL (mock never called).

Then in `app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts`, add the import and one line in the vanished-id loop:

```ts
import { disposePromptWatcher } from '@/renderer/lib/prompt-watcher';
```

```ts
    for (const id of everSeen.current) {
      if (seenNow.has(id)) continue;
      if (hasCached(id)) destroy(id);
      closeScratchForParent(id);
      disposePromptWatcher(id); // 2026-06-10 finding 4 — no-op if never watched
    }
```

Run again → expected PASS (8 tests).

- [ ] **Step 11: Commit**

```bash
git add src/renderer/features/command-room/use-prompt-card.ts \
        src/renderer/features/command-room/use-prompt-card.test.ts \
        src/renderer/app/state-hooks/use-terminal-cache-gc.ts \
        src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts
git commit -m "fix(panes): usePromptCard rides the persistent watcher; GC disposes it with the session"
```

---

### Task 5: Cache hit must refresh the link-routing context (Finding 5a)

**Files:**
- Modify: `app/src/renderer/lib/terminal-cache.ts:90-127` (CacheEntry), `:175-196` (buildTerminalOptions), `:224-241` (getOrCreateTerminal hit path + WebLinks wiring)
- Test: `app/src/renderer/lib/terminal-cache.test.ts`

`getOrCreateTerminal` ignores the fresh `ctx` on cache hit, freezing the FIRST mount's `wsIdRef`/`surfaceBrowser` into the link-handler closures forever (each `SessionTerminal` mount creates a new `useRef`, so the captured one goes dead after the first remount). Fix: the entry owns a mutable `ctxRef`; closures read through it; the hit path refreshes it — making the interface comment ("we accept the latest reference on every getOrCreate call") true.

- [ ] **Step 1: Write the failing test**

Append to `app/src/renderer/lib/terminal-cache.test.ts`:

```ts
// ── 2026-06-10 finding 5a — cache hit refreshes the link-routing context ────
describe('terminal-cache — ctx refresh on cache hit (2026-06-10 finding 5a)', () => {
  it('routes link clicks through the LATEST mount ctx, not the first', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');

    const routeA = vi.fn();
    const ctxA = { wsIdRef: { current: 'ws-A' as string | undefined }, routeLinkClick: routeA };
    getOrCreateTerminal('ctx-1', ctxA);

    // Remount with a FRESH ctx (new wsIdRef holder — exactly what a new
    // SessionTerminal mount produces) pointing at a different workspace.
    const routeB = vi.fn();
    const surfaceB = vi.fn();
    const ctxB = {
      wsIdRef: { current: 'ws-B' as string | undefined },
      routeLinkClick: routeB,
      surfaceBrowser: surfaceB,
    };
    getOrCreateTerminal('ctx-1', ctxB);

    // Drive the OSC8 linkHandler captured at construction.
    const opts = createdTerms[0]!.__ctorArg as {
      linkHandler: { activate: (e: unknown, text: string) => void };
    };
    opts.linkHandler.activate(null, 'https://example.com');

    expect(routeB).toHaveBeenCalledWith('https://example.com', 'ws-B', surfaceB);
    expect(routeA).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: FAIL — `routeA` was called with `'ws-A'`; `routeB` never called (closure froze the first ctx).

- [ ] **Step 3: Implement the ctxRef**

In `app/src/renderer/lib/terminal-cache.ts`:

(a) Update the `TerminalCacheContext` doc comment on `wsIdRef` is still accurate; add to `CacheEntry` (after `webglAddon` from Task 3):

```ts
  /** 2026-06-10 finding 5a — mutable holder for the LATEST mount's context.
   *  The linkHandler/WebLinks closures read through this ref, and the cache-
   *  hit path refreshes it, so links always route via the current mount's
   *  wsIdRef + surfaceBrowser instead of the first mount's dead refs. */
  ctxRef: { current: TerminalCacheContext };
```

(b) Change `buildTerminalOptions` to take the holder (replace the signature and the linkHandler body, lines 175-196):

```ts
function buildTerminalOptions(ctxRef: { current: TerminalCacheContext }): ITerminalOptions {
  return {
    fontFamily:
      'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: false,
    scrollback: 8000,
    theme: THEME,
    convertEol: true,
    // V3-W13-002 — OSC8 hyperlink activation. Plain URLs go through the
    // WebLinksAddon below; this handles `\x1b]8;;…` sequences from CLIs
    // like claude / gh / ripgrep --hyperlink. Reads through ctxRef so a
    // remount's fresh context takes effect (2026-06-10 finding 5a).
    linkHandler: {
      activate: (_event, text) => {
        const c = ctxRef.current;
        c.routeLinkClick(text, c.wsIdRef.current, c.surfaceBrowser);
      },
    },
  };
}
```

(c) In `getOrCreateTerminal`, refresh on hit and wire the miss path through the holder (replace lines 228-241):

```ts
  const existing = cache.get(sessionId);
  if (existing) {
    // 2026-06-10 finding 5a — accept the latest mount's context so the
    // link-handler closures stop reading the first mount's dead refs.
    existing.ctxRef.current = ctx;
    existing.lastAccessed = Date.now();
    return existing;
  }
  evictOldestIfFull();

  const ctxRef = { current: ctx };
  const term = new XTerm(buildTerminalOptions(ctxRef));
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      const c = ctxRef.current;
      c.routeLinkClick(uri, c.wsIdRef.current, c.surfaceBrowser);
    }),
  );
```

(d) Add `ctxRef,` to the `CacheEntry` literal (next to `webglAddon: null,`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/terminal-cache.ts src/renderer/lib/terminal-cache.test.ts
git commit -m "fix(panes): cache hit refreshes link-routing ctx — links route via the current workspace"
```

---

### Task 6: Snapshot/live double-write dedup (Finding 5b)

**Files:**
- Modify: `app/src/renderer/lib/terminal-cache.ts:345-358` (snapshot drain IIFE)
- Modify: `app/src/main/rpc-router.ts:995-997` (`pty.snapshot` handler — 1-line flush)
- Test: `app/src/renderer/lib/terminal-cache.test.ts`

Verified main-side (see Verification notes): no dedup exists; the ring buffer is appended per raw chunk while the renderer broadcast is coalesced up to 12 ms — so bytes can land in BOTH the snapshot buffer and a live chunk. Two-part fix: (1) main flushes the coalescer for the session BEFORE reading the ring buffer, so every byte in the returned buffer was broadcast-sent before the RPC response (Electron orders main→renderer IPC) and all duplicates sit in `pending` at drain time; (2) the renderer drops the overlap between the snapshot's tail and the pending stream's head, preserving per-chunk writes. False-positive risk (a live chunk legitimately identical to the snapshot tail, e.g. a repeated spinner frame) is bounded: the dedup runs exactly once per cache-miss, only against the subscribe→resolve window. The end-to-end IPC-ordering property is only verifiable by CI e2e / operator smoke; units cover the renderer overlap logic.

- [ ] **Step 1: Write the failing renderer tests**

Append to `app/src/renderer/lib/terminal-cache.test.ts`:

```ts
// ── 2026-06-10 finding 5b — snapshot ∩ pending dedup (no double-written text) ─
describe('terminal-cache — snapshot drain dedup (2026-06-10 finding 5b)', () => {
  it('drops a pending chunk fully contained in the snapshot tail', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('dedup-1', ctx);
    const term = entry.terminal as unknown as MockTerm;

    // The chunk reaches the renderer through the live bus AND was already in
    // the main ring buffer when the snapshot was read (the 12ms coalescer
    // window) — i.e. the snapshot ENDS with it.
    emitData('dedup-1', 'AAA');
    snapshotControllers.get('dedup-1')?.resolve({ buffer: 'PREFIX-AAA' });
    await Promise.resolve();
    await Promise.resolve();

    expect(term.__writes).toEqual(['PREFIX-AAA']); // 'AAA' NOT written twice
  });

  it('trims a partial overlap and writes only the unseen suffix', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('dedup-2', ctx);
    const term = entry.terminal as unknown as MockTerm;

    emitData('dedup-2', 'BBCC'); // 'BB' is already in the snapshot; 'CC' is new
    snapshotControllers.get('dedup-2')?.resolve({ buffer: 'XX-BB' });
    await Promise.resolve();
    await Promise.resolve();

    expect(term.__writes).toEqual(['XX-BB', 'CC']);
  });

  it('handles overlap spanning multiple pending chunks', async () => {
    const { getOrCreateTerminal } = await import('./terminal-cache');
    const entry = getOrCreateTerminal('dedup-3', ctx);
    const term = entry.terminal as unknown as MockTerm;

    emitData('dedup-3', 'AB'); // entirely duplicated
    emitData('dedup-3', 'CD'); // 'C' duplicated, 'D' new
    snapshotControllers.get('dedup-3')?.resolve({ buffer: 'snap:ABC' });
    await Promise.resolve();
    await Promise.resolve();

    expect(term.__writes).toEqual(['snap:ABC', 'D']);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: FAIL — writes contain the duplicated bytes (e.g. `['PREFIX-AAA', 'AAA']`). The pre-existing Layer-1 tests (`SNAP-PREFIX` + distinct chunks, rejected-snapshot drain) must still PASS before AND after the fix — their data has no overlap.

- [ ] **Step 3: Implement the renderer-side dedup**

In `app/src/renderer/lib/terminal-cache.ts`, replace the snapshot IIFE (lines 345-358):

```ts
  // Kick off the snapshot in the background. Race-safe: any chunks that
  // arrived between bus-subscribe and snapshot-resolve are in `pending`
  // and drain here. On hot-remount we never hit this path again because
  // the cache entry already exists.
  //
  // 2026-06-10 finding 5b — main appends to the ring buffer per raw chunk
  // but coalesces the renderer broadcast (≤12ms, PERF-1), so a byte can be
  // in BOTH the snapshot buffer and a pending live chunk. The pty.snapshot
  // handler now flushes the coalescer before reading the ring (rpc-router),
  // which — with ordered main→renderer IPC — guarantees every duplicated
  // byte is in `pending` by the time the response lands. Here we drop the
  // longest snapshot-tail / pending-head overlap, preserving per-chunk
  // writes for the unseen remainder. The scan is capped: a duplicate window
  // is at most one coalescer flush (~64KiB burst cap), and this runs once
  // per cache miss.
  void (async () => {
    let snapBuffer = '';
    try {
      const snap = await rpc.pty.snapshot(sessionId);
      if (!cache.has(sessionId)) return;
      if (snap.buffer) {
        snapBuffer = snap.buffer;
        term.write(snapBuffer);
      }
    } catch {
      /* snapshot is best-effort; the live subscription already captured
         everything since the bus listener attached. */
    }
    const joined = pending.join('');
    let overlap = 0;
    if (snapBuffer && joined) {
      const MAX_OVERLAP_SCAN = 65_536; // coalescer maxBytes — the largest single flush
      const max = Math.min(snapBuffer.length, joined.length, MAX_OVERLAP_SCAN);
      for (let k = max; k > 0; k--) {
        if (snapBuffer.endsWith(joined.slice(0, k))) {
          overlap = k;
          break;
        }
      }
    }
    let skip = overlap;
    for (const chunk of pending) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      term.write(skip > 0 ? chunk.slice(skip) : chunk);
      skip = 0;
    }
    pending.length = 0;
    snapshotDone = true;
    entry.snapshotReady = true;
  })();
```

- [ ] **Step 4: Run the renderer suite**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: PASS — including the untouched pre-existing Layer-1 ordering tests.

- [ ] **Step 5: Main-side — flush the coalescer before the snapshot read**

In `app/src/main/rpc-router.ts`, replace the `snapshot` handler (lines 995-997):

```ts
    snapshot: async (sessionId: string) => {
      // 2026-06-10 finding 5b — broadcast any coalesced-but-unsent bytes for
      // this session BEFORE reading the ring buffer. Main→renderer IPC is
      // ordered, so the flushed `pty:data` lands before this RPC response —
      // every byte in the returned buffer that the renderer will also see
      // live is then sitting in its pre-snapshot pending queue, where the
      // terminal-cache drain dedups it (no double-written text on attach).
      ptyDataCoalescer.flush(sessionId);
      return { buffer: pty.snapshot(sessionId) };
    },
```

(`ptyDataCoalescer` is in scope — it is created at `rpc-router.ts:461` in the same router-setup closure and already used at lines 484/486/570. `rpc-router.ts` has no isolated unit harness — this 2 lines is gated by `tsc`, the existing `pty-data-coalescer.test.ts` contract for `flush()`, and CI e2e.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/lib/terminal-cache.ts src/renderer/lib/terminal-cache.test.ts src/main/rpc-router.ts
git commit -m "fix(panes): dedup snapshot/live overlap on first attach — kill double-written text"
```

---

### Task 7: Sibling sweep + full gate

**Files:**
- No planned modifications — investigation step; fix-or-file only.

- [ ] **Step 1: Grep for sibling per-mount state that mirrors per-session lifecycle**

This batch fixed two instances of the same bug class (per-mount `useState`/effect holding per-SESSION facts: scratch tabs, prompt watcher — same class as the PaneSplash whiteout). Sweep the rest of the room:

Run from `/Users/aisigma/projects/SigmaLink/app`:

```bash
grep -n "useState\|useRef" src/renderer/features/command-room/*.tsx src/renderer/features/command-room/*.ts | grep -v ".test."
```

For each hit, ask: "does this state describe a per-SESSION fact that must survive a remount (room/workspace switch)?" Expected findings and dispositions:
- `PaneShell.tsx` `promptCardsEnabled` (KV read per mount) — per-mount read of a global setting; re-reads are cheap and correct. LEAVE.
- `PaneShell.tsx` `isDragOver`/`flashDrop`/`createWorktreeOpen`/`activeTabId` — genuinely per-mount UI. LEAVE.
- `CommandRoom.tsx` `providers`/`emptyStateAdding`/`showWorktreeBanner`/`wsHeaderDragOver` — per-mount UI / cheap refetch. LEAVE.
- `Terminal.tsx` mount-effect locals (`debounceTimer`, `inDividerDrag`, `lastCols/lastRows`) — deliberately per-mount (documented in the file header). LEAVE.
- Anything ELSE that looks like per-session lifecycle state → do NOT fix in this plan; add it to `WISHLIST.md` via the wishlist skill with a pointer to this plan's Architecture section.

Document the sweep result (hits reviewed + dispositions) in the Step 3 commit message body.

- [ ] **Step 2: Full gate**

Run from `/Users/aisigma/projects/SigmaLink/app`:

```bash
npx tsc -b
npx eslint . --max-warnings 0
npx vitest run
npm run product:check
```

Expected: all green. Do NOT run `npx playwright test` locally (CI e2e-matrix covers it on the PR). If a full-`vitest` run hits a known under-load flake (swarms/factory, VoiceTab timeouts), re-run that file in isolation before reacting.

- [ ] **Step 3: Final commit (only if the sweep changed anything; otherwise amend nothing)**

```bash
git add -A
git commit -m "fix(panes): terminal-cache/scratch lifecycle batch — sibling sweep + gate

Sweep results: <list each reviewed per-mount state hit + LEAVE/fixed/wishlist>"
```

---

## Coordination notes (sibling plans in the 2026-06-10 audit batch)

- **perf-render plan** (ChatTranscript / MailboxBubble): DISJOINT — no shared files with this plan. Note `ChatTranscript.tsx` + `ChatTranscript.stream.test.tsx` are already dirty in the working tree from other work; this plan never touches them.
- **renderer-state plan** (CommandRoom-adjacent files): **flag — PaneShell.tsx + use-terminal-cache-gc.ts overlap risk.** This plan rewrites PaneShell's scratch-state block (lines 140-217) and extends the GC hook. If the renderer-state plan touches `PaneShell.tsx`, `CommandRoom.tsx` consumers of `handleRemove`, or `use-terminal-cache-gc.ts`, land THIS plan first (it changes the scratch-tab data flow contract that PaneShell renders from) or rebase that plan's lane on this one. `CommandRoom.tsx` itself is read-but-not-modified here, so CommandRoom-only edits are safe to run in parallel.
- **Concurrent-tree discipline:** this repo suffers shared-tree stomps under concurrent sessions — execute in an isolated worktree off `origin/main` (or the current feature branch base), commit atomically per task, push early. Agents executing tasks must be dispatched with `isolation: "worktree"` on the Agent call.
- **After landing:** dispatch the `testgaps` background worker (feature-adjacent tests added) and note the WebGL/operator-only verifications (Task 3, Task 6) in the PR body for the CI e2e reviewer.

## Self-review (performed before saving; issues found were fixed inline)

1. **Spec coverage:** finding 1a (per-mount state) → Task 1 Steps 6-10; 1b (pane close never kills scratch) + 1c (no cache destroy) → Task 1 store + GC (all three REMOVE_SESSION sites verified: CommandRoom.tsx:261, :290, use-exited-session-gc.ts:39); finding 2 → Task 2; finding 3 → Task 3 (PR #133 preservation called out; fit/drag logic untouched in Terminal.tsx); finding 4 → Task 4 (bus-no-replay verified at pty-data-bus.ts:53-65; rescan alternative explicitly rejected with reason); finding 5a → Task 5; finding 5b → Task 6 (main-side behavior verified before planning, as instructed). Refuted: none.
2. **Placeholder scan:** every code step contains complete code; every test step has full test bodies + exact run command + expected failure mode. No TBDs.
3. **Type consistency (fixed inline during review):** `CacheEntry` gains `webglAddon` (Task 3) before `ctxRef` (Task 5) — both entry-literal insertions are specified in their own tasks so out-of-order execution still compiles per-task; `ScratchTab` is structurally identical between `scratch-tabs.ts` and `PaneTabStrip.tsx` (no import-direction change needed); `closeScratchTab(parentId, scratchId)` signature consistent across store, PaneShell, and store tests; `getScratchParentIds()` used by both the GC and its mock; prompt-watcher exports match the GC mock and the use-prompt-card imports; Task 2's eviction test pins `lastAccessed` manually after `attachToHost` because Task 3 later keeps the bump — test remains valid in either task order.
4. **Known accepted trade-offs (documented in tasks):** cache may exceed the LRU cap when all entries are attached (bounded by mounted panes); prompt emitted before a session's first-ever enabled mount is still missed (bus has no replay — out of scope); 5b dedup has a bounded false-positive window; `activeTabId` resets to main on remount.
