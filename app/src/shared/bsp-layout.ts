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
