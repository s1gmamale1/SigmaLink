# BridgeSpace BSP Pane Tiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-count CSS grid in the Command Room with a custom binary-space-partition (BSP) tiling layout: panes fill all space, each border resizes only its two neighbours, panes auto-split the focused pane, square corners.

**Architecture:** A pure, unit-tested tree module (`shared/bsp-layout.ts`) owns the data model + all tree operations. A recursive React renderer (`BspLayout` + `BspDivider`) renders the tree, reconciles it against the authoritative session list every render, and persists it per-workspace in KV. Leaves render the existing `PaneShell`, keyed by `sessionId` so terminals never remount on relayout. `GridLayout`/`SplitGroupCell` are retired.

**Tech Stack:** TypeScript, React 19, Tailwind, Vitest (jsdom), the existing `rpc.kv` store and `terminal-cache`.

**Spec:** `docs/superpowers/specs/2026-06-09-bridgespace-bsp-pane-tiling-design.md`

---

## File Structure

- **Create** `app/src/shared/bsp-layout.ts` — pure types + ops (`BspNode`, `splitLeaf`, `removeLeaf`, `setRatio`, `leafIds`, `balancedTree`, `reconcile`, `nodeAtPath`). No React/DOM/IPC.
- **Create** `app/src/shared/bsp-layout.test.ts` — pure unit tests (Vitest, node env).
- **Create** `app/src/renderer/features/command-room/BspDivider.tsx` — one draggable/keyboard-resizable splitter for a split node.
- **Create** `app/src/renderer/features/command-room/BspLayout.tsx` — recursive renderer + reconcile + KV persistence + fullscreen + auto-split direction hint.
- **Create** `app/src/renderer/features/command-room/BspLayout.test.tsx` — jsdom render/interaction tests.
- **Modify** `app/src/renderer/features/command-room/CommandRoom.tsx` — swap `GridLayout`→`BspLayout`; drop `groupSessionsIntoCells`/`SessionCell`; move per-pane render into `renderLeaf`.
- **Modify** `app/src/renderer/features/command-room/PaneShell.tsx` (only if a rounded class lives here — recon says it does not; verify).
- **Delete** `app/src/renderer/features/command-room/GridLayout.tsx` + `GridLayout.test.tsx`, `SplitGroupCell.tsx` (+ any `SplitGroupCell.test.tsx`).
- **Modify** `app/tests/e2e/pane-split.spec.ts` — rewrite for BSP semantics.

Convention reminder (from `app/CLAUDE.md`): each file < 500 lines; gate in MAIN; for code-editing agents pass `isolation:"worktree"` on the Agent call.

---

## Task 1: Pure BSP layout module

**Files:**
- Create: `app/src/shared/bsp-layout.ts`
- Test: `app/src/shared/bsp-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/src/shared/bsp-layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  type BspNode,
  splitLeaf,
  removeLeaf,
  setRatio,
  leafIds,
  balancedTree,
  reconcile,
  MIN_RATIO,
} from './bsp-layout';

const leaf = (id: string): BspNode => ({ type: 'leaf', sessionId: id });

describe('leafIds', () => {
  it('returns leaves left-to-right (a before b)', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('x'), b: { type: 'split', dir: 'h', ratio: 0.5, a: leaf('y'), b: leaf('z') } };
    expect(leafIds(tree)).toEqual(['x', 'y', 'z']);
  });
  it('handles a single leaf and null', () => {
    expect(leafIds(leaf('only'))).toEqual(['only']);
    expect(leafIds(null)).toEqual([]);
  });
});

describe('splitLeaf', () => {
  it('replaces the target leaf with a split {a:target, b:new}', () => {
    const out = splitLeaf(leaf('a'), 'a', 'b', 'v', 0.5);
    expect(out).toEqual({ type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') });
  });
  it('splits a nested target without touching siblings', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    const out = splitLeaf(tree, 'b', 'c', 'h', 0.5);
    expect(leafIds(out)).toEqual(['a', 'b', 'c']);
    // a-subtree identity preserved (only b changed)
    expect((out as Extract<BspNode, { type: 'split' }>).a).toBe(tree.a);
  });
  it('returns the tree unchanged when the target is absent', () => {
    const tree = leaf('a');
    expect(splitLeaf(tree, 'zzz', 'b', 'v', 0.5)).toBe(tree);
  });
});

describe('removeLeaf', () => {
  it('collapses the parent split into the surviving sibling', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.3, a: leaf('a'), b: leaf('b') };
    expect(removeLeaf(tree, 'a')).toEqual(leaf('b'));
  });
  it('removes a nested leaf and collapses only its parent', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: { type: 'split', dir: 'h', ratio: 0.5, a: leaf('b'), b: leaf('c') } };
    expect(removeLeaf(tree, 'b')).toEqual({ type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('c') });
  });
  it('returns null when the last leaf is removed', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
  });
  it('returns the same reference when the id is absent', () => {
    const tree = leaf('a');
    expect(removeLeaf(tree, 'zzz')).toBe(tree);
  });
});

describe('setRatio', () => {
  it('updates only the addressed split node and clamps to [MIN_RATIO, 1-MIN_RATIO]', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    expect(setRatio(tree, [], 0.8)).toMatchObject({ ratio: 0.8 });
    expect(setRatio(tree, [], 0.0001)).toMatchObject({ ratio: MIN_RATIO });
    expect(setRatio(tree, [], 0.9999)).toMatchObject({ ratio: 1 - MIN_RATIO });
  });
  it('addresses a nested split by path of a|b', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: { type: 'split', dir: 'h', ratio: 0.5, a: leaf('b'), b: leaf('c') } };
    const out = setRatio(tree, ['b'], 0.7) as Extract<BspNode, { type: 'split' }>;
    expect((out.b as Extract<BspNode, { type: 'split' }>).ratio).toBe(0.7);
    expect(out.a).toBe(tree.a); // untouched subtree keeps identity
  });
});

describe('balancedTree', () => {
  it('builds a single leaf for one id and null for none', () => {
    expect(balancedTree([])).toBeNull();
    expect(balancedTree(['a'])).toEqual(leaf('a'));
  });
  it('fills space for 3 ids with no empty cell (1 | (2/3))', () => {
    const t = balancedTree(['a', 'b', 'c']);
    expect(leafIds(t)).toEqual(['a', 'b', 'c']);
    expect((t as Extract<BspNode, { type: 'split' }>).dir).toBe('v');
  });
  it('alternates split direction by depth', () => {
    const t = balancedTree(['a', 'b', 'c', 'd']) as Extract<BspNode, { type: 'split' }>;
    expect(t.dir).toBe('v');
    expect((t.a as Extract<BspNode, { type: 'split' }>).dir).toBe('h');
  });
});

describe('reconcile', () => {
  it('builds a balanced tree from scratch when tree is null', () => {
    expect(leafIds(reconcile(null, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });
  it('drops leaves whose session is gone and collapses', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    expect(reconcile(tree, ['b'])).toEqual(leaf('b'));
  });
  it('inserts a new session by splitting the focused leaf', () => {
    const tree = leaf('a');
    const out = reconcile(tree, ['a', 'b'], { focusId: 'a', dirHint: 'v' });
    expect(out).toEqual({ type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') });
  });
  it('never strands a live session or keeps a dead leaf', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    const out = reconcile(tree, ['b', 'c', 'd'], { focusId: 'b' });
    expect(leafIds(out).sort()).toEqual(['b', 'c', 'd']);
  });
  it('returns the same reference when already in sync (no spurious save)', () => {
    const tree: BspNode = { type: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    expect(reconcile(tree, ['a', 'b'])).toBe(tree);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/shared/bsp-layout.test.ts`
Expected: FAIL — `Cannot find module './bsp-layout'`.

- [ ] **Step 3: Implement the module**

Create `app/src/shared/bsp-layout.ts`:

```ts
// Pure binary-space-partition layout model for the Command Room pane tiling.
// No React, no DOM, no IPC — fully unit-testable. The session list is the
// authoritative source of truth; `reconcile` heals a persisted tree against it.

export type BspNode =
  | { type: 'leaf'; sessionId: string }
  | { type: 'split'; dir: 'h' | 'v'; ratio: number; a: BspNode; b: BspNode };
//  dir 'v' → vertical divider: a = left,  b = right
//  dir 'h' → horizontal divider: a = top, b = bottom
//  ratio   → fraction (0..1) of the parent allocated to child `a`; b gets 1-ratio

export type BspTree = BspNode | null;

/** A node address: sequence of 'a'|'b' from the root to the split node. */
export type BspPath = ReadonlyArray<'a' | 'b'>;

export const MIN_RATIO = 0.1;

const isSplit = (n: BspNode): n is Extract<BspNode, { type: 'split' }> => n.type === 'split';

export function leafIds(tree: BspTree): string[] {
  if (!tree) return [];
  if (tree.type === 'leaf') return [tree.sessionId];
  return [...leafIds(tree.a), ...leafIds(tree.b)];
}

/** Replace the `targetId` leaf with a split {a: target, b: new leaf}. Returns the
 *  same reference if the target is absent so callers can detect no-ops. */
export function splitLeaf(
  tree: BspNode,
  targetId: string,
  newId: string,
  dir: 'h' | 'v',
  ratio = 0.5,
): BspNode {
  if (tree.type === 'leaf') {
    if (tree.sessionId !== targetId) return tree;
    return { type: 'split', dir, ratio, a: tree, b: { type: 'leaf', sessionId: newId } };
  }
  const a = splitLeaf(tree.a, targetId, newId, dir, ratio);
  const b = a === tree.a ? splitLeaf(tree.b, targetId, newId, dir, ratio) : tree.b;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/** Remove a leaf and collapse its parent split into the surviving sibling.
 *  Returns null if the removed leaf was the whole tree; same ref if absent. */
export function removeLeaf(tree: BspTree, sessionId: string): BspTree {
  if (!tree) return null;
  if (tree.type === 'leaf') return tree.sessionId === sessionId ? null : tree;
  const a = removeLeaf(tree.a, sessionId);
  if (a === null) return tree.b;
  const b = a === tree.a ? removeLeaf(tree.b, sessionId) : tree.b;
  if (b === null) return tree.a;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/** Update the ratio of the split node addressed by `path` (clamped). */
export function setRatio(tree: BspNode, path: BspPath, ratio: number): BspNode {
  const clamped = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
  if (path.length === 0) {
    if (!isSplit(tree)) return tree;
    return { ...tree, ratio: clamped };
  }
  if (!isSplit(tree)) return tree;
  const [head, ...rest] = path;
  if (head === 'a') {
    const a = setRatio(tree.a, rest, clamped);
    return a === tree.a ? tree : { ...tree, a };
  }
  const b = setRatio(tree.b, rest, clamped);
  return b === tree.b ? tree : { ...tree, b };
}

/** Build a balanced, direction-alternating tree from an ordered id list. */
export function balancedTree(ids: string[], depth = 0): BspTree {
  if (ids.length === 0) return null;
  if (ids.length === 1) return { type: 'leaf', sessionId: ids[0]! };
  const mid = Math.ceil(ids.length / 2);
  const dir: 'h' | 'v' = depth % 2 === 0 ? 'v' : 'h';
  return {
    type: 'split',
    dir,
    ratio: 0.5,
    a: balancedTree(ids.slice(0, mid), depth + 1)!,
    b: balancedTree(ids.slice(mid), depth + 1)!,
  };
}

/** Drop every leaf not in `keep`, collapsing splits. Preserves identity when
 *  nothing changed (so reconcile can return the same tree reference). */
function prune(tree: BspTree, keep: Set<string>): BspTree {
  if (!tree) return null;
  if (tree.type === 'leaf') return keep.has(tree.sessionId) ? tree : null;
  const a = prune(tree.a, keep);
  const b = prune(tree.b, keep);
  if (a === null) return b;
  if (b === null) return a;
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

export interface ReconcileOpts {
  /** Leaf to split when inserting new sessions (defaults to the last leaf). */
  focusId?: string;
  /** Direction for inserts (defaults to 'v'). BspLayout supplies this by aspect. */
  dirHint?: 'h' | 'v';
}

/** Heal `tree` so its leaves exactly equal `liveIds`. Authoritative = liveIds.
 *  - removes leaves whose session is gone (collapse)
 *  - inserts missing sessions by splitting the focus leaf
 *  - returns the SAME reference when already in sync */
export function reconcile(tree: BspTree, liveIds: string[], opts: ReconcileOpts = {}): BspTree {
  const keep = new Set(liveIds);
  const pruned = prune(tree, keep);
  if (!pruned) return balancedTree(liveIds);
  const placed = leafIds(pruned);
  const placedSet = new Set(placed);
  const missing = liveIds.filter((id) => !placedSet.has(id));
  if (missing.length === 0) return pruned;
  let result: BspNode = pruned;
  let focus = opts.focusId && placedSet.has(opts.focusId) ? opts.focusId : placed[placed.length - 1]!;
  const dir = opts.dirHint ?? 'v';
  for (const id of missing) {
    result = splitLeaf(result, focus, id, dir, 0.5);
    focus = id; // a burst of new panes stacks near each other
  }
  return result;
}

/** Address (path + node) of the split that is the parent divider — used by the
 *  renderer to map a Divider back to its node for setRatio. */
export function nodeAtPath(tree: BspTree, path: BspPath): BspTree {
  let cur: BspTree = tree;
  for (const step of path) {
    if (!cur || cur.type !== 'split') return null;
    cur = step === 'a' ? cur.a : cur.b;
  }
  return cur;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/shared/bsp-layout.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/bsp-layout.ts app/src/shared/bsp-layout.test.ts
git commit -m "feat(command-room): pure BSP layout tree model + ops (DEV-L2)"
```

---

## Task 2: BspDivider component

**Files:**
- Create: `app/src/renderer/features/command-room/BspDivider.tsx`

A 1px hairline splitter with a ±3px transparent hit-area. Pointer drag reports a new
ratio (rAF-coalesced, sets `document.body.dataset.dragging` so `Terminal.tsx` relaxes
its refit debounce). Arrow keys nudge 2%. The parent (`BspLayout`/`BspBranch`) owns the
container ref and converts a pointer delta to a ratio.

- [ ] **Step 1: Implement the component**

Create `app/src/renderer/features/command-room/BspDivider.tsx`:

```tsx
// One resizable splitter between the two children of a split node.
// Drag (or arrow keys) reports the new ratio for child `a`. The owning branch
// passes the container size accessor so this component stays presentation-only.

import { useRef } from 'react';

interface Props {
  dir: 'h' | 'v';
  ratio: number;
  /** Pixel size of the parent split container along the split axis. */
  getContainerSize: () => number;
  /** Commit a new ratio (already in 0..1; BspLayout clamps via setRatio). */
  onRatio: (ratio: number) => void;
}

const NUDGE = 0.02;

export function BspDivider({ dir, ratio, getContainerSize, onRatio }: Props) {
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  function flush() {
    rafRef.current = null;
    if (pendingRef.current !== null) {
      onRatio(pendingRef.current);
      pendingRef.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.dataset.dragging = 'true';
    const size = getContainerSize();
    const startPos = dir === 'v' ? e.clientX : e.clientY;
    const startRatio = ratio;

    const move = (ev: PointerEvent) => {
      const pos = dir === 'v' ? ev.clientX : ev.clientY;
      if (size <= 0) return;
      const next = startRatio + (pos - startPos) / size;
      pendingRef.current = next;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      flush();
      delete document.body.dataset.dragging;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dec = dir === 'v' ? 'ArrowLeft' : 'ArrowUp';
    const inc = dir === 'v' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) { e.preventDefault(); onRatio(ratio - NUDGE); }
    else if (e.key === inc) { e.preventDefault(); onRatio(ratio + NUDGE); }
  }

  return (
    <div
      role="separator"
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      data-testid="bsp-divider"
      data-dir={dir}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={[
        'relative z-10 shrink-0 bg-border',
        dir === 'v'
          ? 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-[3px] before:-right-[3px] before:content-[""]'
          : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-[3px] before:-bottom-[3px] before:content-[""]',
        'outline-none focus-visible:bg-[hsl(var(--ring))]',
      ].join(' ')}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc -b`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/src/renderer/features/command-room/BspDivider.tsx
git commit -m "feat(command-room): BspDivider splitter (drag + keyboard resize)"
```

---

## Task 3: BspLayout renderer + reconcile + persistence

**Files:**
- Create: `app/src/renderer/features/command-room/BspLayout.tsx`
- Test: `app/src/renderer/features/command-room/BspLayout.test.tsx`

`BspLayout` owns the tree state (seeded from KV `bsp.tree.<workspaceId>`), reconciles it
against the live session ids every render, persists on change (debounced), renders the
recursive branch/leaf structure, handles fullscreen, and computes the auto-split direction
from the focused leaf's measured rect (recorded in a ref map keyed by sessionId).

- [ ] **Step 1: Write the failing tests**

Create `app/src/renderer/features/command-room/BspLayout.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';

const kvGet = vi.fn<(k: string) => Promise<string | null>>().mockResolvedValue(null);
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: { kv: { get: (k: string) => kvGet(k), set: (k: string, v: string) => kvSet(k, v) } },
}));
vi.mock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => true }));

import { BspLayout } from './BspLayout';

const leafRender = (id: string) => <div data-testid={`leaf-${id}`}>{id}</div>;

beforeEach(() => { kvGet.mockReset().mockResolvedValue(null); kvSet.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderLayout(ids: string[], focusedPaneId: string | null = null) {
  return render(
    <BspLayout
      sessionIds={ids}
      activeSessionId={ids[0] ?? null}
      focusedPaneId={focusedPaneId}
      workspaceId="ws1"
      onActivate={() => {}}
      renderLeaf={leafRender}
    />,
  );
}

describe('BspLayout', () => {
  it('renders a leaf per session', async () => {
    renderLayout(['a', 'b', 'c']);
    await act(async () => {});
    expect(screen.getByTestId('leaf-a')).toBeTruthy();
    expect(screen.getByTestId('leaf-b')).toBeTruthy();
    expect(screen.getByTestId('leaf-c')).toBeTruthy();
  });

  it('renders N-1 dividers for N panes', async () => {
    renderLayout(['a', 'b', 'c']);
    await act(async () => {});
    expect(screen.getAllByTestId('bsp-divider')).toHaveLength(2);
  });

  it('renders only the focused leaf when fullscreen, others kept mounted', async () => {
    renderLayout(['a', 'b'], 'a');
    await act(async () => {});
    // both leaves stay mounted (terminal-cache contract); non-focused is display:none
    const b = screen.getByTestId('leaf-b');
    expect(b).toBeTruthy();
    const hiddenHost = b.closest('[data-bsp-hidden="true"]');
    expect(hiddenHost).not.toBeNull();
  });

  it('persists the tree to KV after a structural change', async () => {
    const { rerender } = renderLayout(['a']);
    await act(async () => {});
    rerender(
      <BspLayout sessionIds={['a', 'b']} activeSessionId="a" focusedPaneId={null} workspaceId="ws1" onActivate={() => {}} renderLeaf={leafRender} />,
    );
    await act(async () => {});
    expect(kvSet).toHaveBeenCalledWith('bsp.tree.ws1', expect.stringContaining('"b"'));
  });

  it('seeds the tree from a persisted KV blob', async () => {
    kvGet.mockResolvedValue(JSON.stringify({ type: 'split', dir: 'h', ratio: 0.3, a: { type: 'leaf', sessionId: 'a' }, b: { type: 'leaf', sessionId: 'b' } }));
    renderLayout(['a', 'b']);
    await act(async () => {});
    expect(screen.getByTestId('bsp-divider').getAttribute('data-dir')).toBe('h');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/renderer/features/command-room/BspLayout.test.tsx`
Expected: FAIL — `Cannot find module './BspLayout'`.

- [ ] **Step 3: Implement BspLayout**

Create `app/src/renderer/features/command-room/BspLayout.tsx`:

```tsx
// Recursive BSP tiling renderer for the Command Room. Owns the per-workspace
// layout tree (seeded from KV), reconciles it against the authoritative live
// session ids every render, persists on change, and renders square-cornered
// leaves separated by BspDivider splitters. Leaves are keyed by sessionId so
// the cached xterm terminals never remount on relayout.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import {
  type BspNode,
  type BspPath,
  type BspTree,
  leafIds,
  reconcile,
  setRatio,
} from '@/shared/bsp-layout';
import { BspDivider } from './BspDivider';

export interface BspLayoutProps {
  sessionIds: string[];
  activeSessionId: string | null;
  focusedPaneId: string | null;
  workspaceId: string | null;
  onActivate: (sessionId: string) => void;
  renderLeaf: (sessionId: string) => React.ReactNode;
}

function kvKey(workspaceId: string): string {
  return `bsp.tree.${workspaceId}`;
}

function parseTree(raw: string | null): BspTree {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as BspTree;
    return t && (t.type === 'leaf' || t.type === 'split') ? t : null;
  } catch {
    return null;
  }
}

export function BspLayout({
  sessionIds,
  activeSessionId,
  focusedPaneId,
  workspaceId,
  onActivate,
  renderLeaf,
}: BspLayoutProps) {
  // Persisted tree (raw, before reconcile). Seeded from KV on workspace change.
  const [storedTree, setStoredTree] = useState<BspTree>(null);
  const [hydrated, setHydrated] = useState(false);
  // Per-leaf host rects, for aspect-aware auto-split direction.
  const leafElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const lastSavedRef = useRef<string>('');

  // Load persisted tree when the workspace changes.
  useEffect(() => {
    let alive = true;
    setHydrated(false);
    void (async () => {
      let tree: BspTree = null;
      if (workspaceId) {
        try { tree = parseTree(await rpcSilent.kv.get(kvKey(workspaceId))); } catch { tree = null; }
      }
      if (!alive) return;
      setStoredTree(tree);
      lastSavedRef.current = tree ? JSON.stringify(tree) : '';
      setHydrated(true);
    })();
    return () => { alive = false; };
  }, [workspaceId]);

  // Aspect of the focused leaf → split direction for the next insert.
  const dirHint = useMemo<'h' | 'v'>(() => {
    const el = activeSessionId ? leafElsRef.current.get(activeSessionId) : undefined;
    if (el) {
      const r = el.getBoundingClientRect();
      return r.width >= r.height ? 'v' : 'h';
    }
    return 'v';
  }, [activeSessionId, sessionIds.length]);

  // The live tree = persisted tree healed against the authoritative session set.
  const tree = useMemo(
    () => reconcile(storedTree, sessionIds, { focusId: activeSessionId ?? undefined, dirHint }),
    [storedTree, sessionIds, activeSessionId, dirHint],
  );

  // Persist when the reconciled tree changes (debounced), once hydrated.
  useEffect(() => {
    if (!hydrated || !workspaceId) return;
    const serialized = tree ? JSON.stringify(tree) : '';
    if (serialized === lastSavedRef.current) return;
    const t = setTimeout(() => {
      lastSavedRef.current = serialized;
      rpcSilent.kv.set(kvKey(workspaceId), serialized).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [tree, hydrated, workspaceId]);

  // setRatio at a path → write back into storedTree (so the user's drag persists).
  const commitRatio = useCallback((path: BspPath, ratio: number) => {
    setStoredTree((prev) => {
      // Apply against the reconciled live tree so paths line up with the DOM,
      // then keep it as the new stored tree.
      const base = reconcile(prev, sessionIds, { focusId: activeSessionId ?? undefined, dirHint });
      if (!base || base.type !== 'split') return prev;
      return setRatio(base, path, ratio);
    });
  }, [sessionIds, activeSessionId, dirHint]);

  const registerLeaf = useCallback((id: string, el: HTMLElement | null) => {
    if (el) leafElsRef.current.set(id, el);
    else leafElsRef.current.delete(id);
  }, []);

  if (!tree) return <div className="min-h-0 flex-1" data-testid="bsp-empty" />;

  return (
    <div className="flex min-h-0 flex-1" data-testid="bsp-layout">
      <BspBranch
        node={tree}
        path={[]}
        focusedPaneId={focusedPaneId}
        activeSessionId={activeSessionId}
        onActivate={onActivate}
        onRatio={commitRatio}
        registerLeaf={registerLeaf}
        renderLeaf={renderLeaf}
      />
    </div>
  );
}

interface BranchProps {
  node: BspNode;
  path: BspPath;
  focusedPaneId: string | null;
  activeSessionId: string | null;
  onActivate: (id: string) => void;
  onRatio: (path: BspPath, ratio: number) => void;
  registerLeaf: (id: string, el: HTMLElement | null) => void;
  renderLeaf: (id: string) => React.ReactNode;
}

function BspBranch(props: BranchProps) {
  const { node, path, focusedPaneId } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (node.type === 'leaf') {
    // Fullscreen: only the focused leaf is visible; the rest stay mounted but
    // display:none (terminal-cache contract — never unmount).
    const hidden = focusedPaneId !== null && focusedPaneId !== node.sessionId;
    const isActive = props.activeSessionId === node.sessionId && focusedPaneId === null;
    return (
      <div
        ref={(el) => props.registerLeaf(node.sessionId, el)}
        data-testid="bsp-leaf"
        data-session-id={node.sessionId}
        data-bsp-hidden={hidden ? 'true' : undefined}
        onMouseDownCapture={() => props.onActivate(node.sessionId)}
        className={[
          'relative min-h-0 min-w-0 overflow-hidden border border-border bg-card',
          isActive ? 'sl-pane-active z-[1] shadow-[0_0_0_1px_hsl(var(--ring))]' : '',
        ].join(' ')}
        style={
          hidden
            ? { display: 'none' }
            : focusedPaneId === node.sessionId
              ? { position: 'absolute', inset: 0, zIndex: 5 }
              : { flex: 1 }
        }
      >
        {props.renderLeaf(node.sessionId)}
      </div>
    );
  }

  // Split node: flex row (v) / column (h); children get flex ratios; divider between.
  const isRow = node.dir === 'v';
  return (
    <div
      ref={containerRef}
      className={['flex min-h-0 min-w-0', isRow ? 'flex-row' : 'flex-col'].join(' ')}
      style={{ flex: 1 }}
      data-testid="bsp-branch"
      data-dir={node.dir}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: node.ratio }}>
        <BspBranch {...props} node={node.a} path={[...path, 'a']} />
      </div>
      <BspDivider
        dir={node.dir}
        ratio={node.ratio}
        getContainerSize={() =>
          isRow
            ? containerRef.current?.getBoundingClientRect().width ?? 0
            : containerRef.current?.getBoundingClientRect().height ?? 0
        }
        onRatio={(r) => props.onRatio(path, r)}
      />
      <div className="flex min-h-0 min-w-0" style={{ flex: 1 - node.ratio }}>
        <BspBranch {...props} node={node.b} path={[...path, 'b']} />
      </div>
    </div>
  );
}
```

Note for the worker: the fullscreen branch positions the focused leaf `absolute inset-0`
over the still-mounted tree; non-focused leaves are `display:none`. This mirrors the
existing GridLayout fullscreen contract (others stay mounted) so terminals are preserved.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/renderer/features/command-room/BspLayout.test.tsx`
Expected: PASS. (If the fullscreen test needs a `data-bsp-hidden` host lookup tweak, adjust the test selector — keep the component contract.)

- [ ] **Step 5: Typecheck + commit**

```bash
cd app && npx tsc -b
git add app/src/renderer/features/command-room/BspLayout.tsx app/src/renderer/features/command-room/BspLayout.test.tsx
git commit -m "feat(command-room): BspLayout recursive tiling renderer + reconcile + KV persist"
```

---

## Task 4: Integrate into CommandRoom; retire GridLayout/SplitGroupCell; square corners

**Files:**
- Modify: `app/src/renderer/features/command-room/CommandRoom.tsx`
- Delete: `GridLayout.tsx`, `GridLayout.test.tsx`, `SplitGroupCell.tsx` (+ test if present)

- [ ] **Step 1: Read the current CommandRoom GridLayout usage**

Run: `cd app && sed -n '36,60p;455,547p' src/renderer/features/command-room/CommandRoom.tsx`
Confirm: `groupSessionsIntoCells`, `SessionCell`, the `<GridLayout items={cells} …>` block (recon: lines ~37-54 and ~458-546), and the `renderCell` split branch.

- [ ] **Step 2: Replace the grouping + grid with BspLayout**

In `CommandRoom.tsx`:
1. Remove the `import { GridLayout }` and `import { SplitGroupCell }` lines; add `import { BspLayout } from './BspLayout';`.
2. Delete `groupSessionsIntoCells`, the `SessionCell` type, and the `cells`/`activeIndex` memos.
3. Replace the entire `<GridLayout<SessionCell> …>…</GridLayout>` JSX with:

```tsx
<BspLayout
  sessionIds={sessions.map((s) => s.id)}
  activeSessionId={activeSessionId}
  focusedPaneId={focusedPaneId}
  workspaceId={activeWorkspaceId}
  onActivate={(id) => {
    if (activeSessionId !== id) dispatch({ type: 'SET_ACTIVE_SESSION', id });
  }}
  renderLeaf={(sessionId) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const paneBindings = skillBindings.filter((b) => b.paneSessionId === session.id);
    const paneIndex = sessions.findIndex((s) => s.id === sessionId) + 1;
    return (
      <PaneShell
        session={session}
        paneIndex={paneIndex}
        providers={providers}
        workspaceRootPath={activeWorkspace.rootPath}
        onFocus={() => { if (activeSessionId !== session.id) dispatch({ type: 'SET_ACTIVE_SESSION', id: session.id }); }}
        onRemove={() => handleRemove(session)}
        onStop={() => handleStop(session)}
        onRelaunch={() => void handleRelaunch(session)}
        onSplit={(dir, providerId) => void handleSplitPane(session, dir, providerId)}
        onToggleMinimise={() => handleToggleMinimise(session)}
        isFullscreen={focusedPaneId === session.id}
        onToggleFullscreen={() =>
          dispatch(focusedPaneId === session.id ? { type: 'UNFOCUS_PANE' } : { type: 'FOCUS_PANE', paneId: session.id })
        }
        skillBindings={paneBindings}
        onSkillDrop={(name, source) => void attachSkill({ paneSessionId: session.id, skillName: name, skillSource: source })}
        onSkillDetach={(bindingId) => void detachSkill(bindingId)}
      />
    );
  }}
/>
```

Notes for the worker:
- `PaneShell`'s `canSplit` no longer needs the `inSplitGroup` gate — every leaf can split now. `PaneShell` already defaults `canSplit` from `!inSplitGroup`; since we never pass `inSplitGroup`, splitting is enabled everywhere (desired). Leave `PaneShell` otherwise unchanged.
- `handleSplitPane` (shared-worktree split) stays — it dispatches `SPLIT_PANE` which adds a session; the reconciler then tiles it. The split DB columns remain but no longer drive layout.

- [ ] **Step 3: Square corners**

The two structural rounded sources were in `GridLayout.tsx` and `SplitGroupCell.tsx`, both being deleted. `BspLayout` leaves use `border border-border` with no `rounded-*` (square). Verify no remaining `rounded-` on a pane tile:

Run: `cd app && grep -rn "rounded" src/renderer/features/command-room/PaneShell.tsx`
Expected: only non-tile chrome (status badges / dots), not the pane container. If the pane *root* has a `rounded-*`, remove it.

- [ ] **Step 4: Delete the retired files**

```bash
cd app && git rm src/renderer/features/command-room/GridLayout.tsx src/renderer/features/command-room/GridLayout.test.tsx src/renderer/features/command-room/SplitGroupCell.tsx
# Remove SplitGroupCell.test.tsx too if it exists:
git rm src/renderer/features/command-room/SplitGroupCell.test.tsx 2>/dev/null || true
```

- [ ] **Step 5: Typecheck (catches every remaining reference)**

Run: `cd app && npx tsc -b`
Expected: exit 0. Fix any dangling imports of `GridLayout`/`SplitGroupCell`/`groupSessionsIntoCells`/`SessionCell` that tsc surfaces (e.g. `grid-fracs` is still used by nobody — leave the file; it's imported by no one now, harmless, or delete if tsc flags it unused via an export check).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(command-room): tile panes with BspLayout; retire GridLayout/SplitGroupCell; square corners"
```

---

## Task 5: Update CommandRoom tests, rewrite e2e, full gate

**Files:**
- Modify: `app/src/renderer/features/command-room/CommandRoom.test.tsx` (if its cell-grouping test referenced `groupSessionsIntoCells`/grid)
- Modify: `app/tests/e2e/pane-split.spec.ts`

- [ ] **Step 1: Fix CommandRoom unit tests**

Run: `cd app && npx vitest run src/renderer/features/command-room/CommandRoom.test.tsx`
For each failure tied to the old grid/cell model, update the assertion to the BSP DOM: panes are `[data-testid="bsp-leaf"]` (one per session); the old `[data-split-group]`/cell-count assertions are replaced by leaf-count. Keep behavioral tests (empty state, drag-drop on `pane-body`, relaunch) intact — `PaneShell` is unchanged.

- [ ] **Step 2: Rewrite the e2e split spec**

Replace `app/tests/e2e/pane-split.spec.ts` assertions:
- Launch a workspace with ≥3 panes; assert `page.locator('[data-testid="bsp-leaf"]')` count == panes and that the bounding boxes **tile the body with no gap/overlap** (sum of areas ≈ container area).
- Drag a `[data-testid="bsp-divider"]` and assert the two adjacent leaves changed width/height while non-adjacent leaves did not.
- Assert a leaf's computed `border-radius` is `0px` (square corners).
Keep it in the same describe/file so CI's e2e-matrix picks it up.

- [ ] **Step 3: Full gate in MAIN**

```bash
cd app
npx tsc -b                        # exit 0
npx eslint . --max-warnings 0     # exit 0
npx vitest run                    # all pass
npm run product:check             # exit 0
```
Do NOT run `playwright` locally (launches Electron, steals operator focus) — the PR's CI e2e-matrix runs the e2e dir.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(command-room): BSP tiling unit + e2e coverage; retire grid tests"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** data model → Task 1; fill-all-space + reconcile → Task 1/3; neighbor-only resize → Task 2/3; auto-split by aspect → Task 3 (`dirHint`); close-collapses → Task 1 (`removeLeaf`) surfaced via reconcile; square corners → Task 4; persistence + no migration → Task 3 (`bsp.tree.<ws>`, old keys ignored); terminal no-remount → Task 3 (leaf key=sessionId, fullscreen display:none); retire grid → Task 4; tests → Task 1/3/5. All spec sections mapped.
- **Placeholders:** none — full code in every implementation step.
- **Type consistency:** `BspNode`/`BspTree`/`BspPath`, `reconcile(tree, ids, {focusId,dirHint})`, `setRatio(tree, path, ratio)`, `leafIds`, `balancedTree` used identically across tasks. `BspLayout` props (`sessionIds`, `activeSessionId`, `focusedPaneId`, `workspaceId`, `onActivate`, `renderLeaf`) match the CommandRoom call site in Task 4.

## Risks during execution
- **Terminal remount:** if a terminal reflashes on split/resize, a leaf key changed — ensure leaves are keyed by `sessionId` only (React keys are stable here because the leaf component identity is the `bsp-leaf` div per sessionId). Manual smoke after Task 4.
- **Ratio path vs DOM:** `commitRatio` reconciles before applying `setRatio` so the path matches what's rendered. If divider drags feel inverted, check `getContainerSize` axis (width for `dir:'v'`).
- **Concurrent shared tree:** integrate on an isolated worktree off `origin/main`; full re-gate in MAIN (per `app/CLAUDE.md`).
