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
