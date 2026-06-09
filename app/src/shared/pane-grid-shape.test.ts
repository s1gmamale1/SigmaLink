import { describe, it, expect } from 'vitest';
import { rowCounts, paneRows, shapeSignature } from './pane-grid-shape';

describe('rowCounts', () => {
  it('distributes panes into ≈round(sqrt(n)) rows, earlier rows fuller', () => {
    expect(rowCounts(1)).toEqual([1]);
    expect(rowCounts(2)).toEqual([2]);
    expect(rowCounts(3)).toEqual([2, 1]);
    expect(rowCounts(4)).toEqual([2, 2]);
    expect(rowCounts(5)).toEqual([3, 2]);
    expect(rowCounts(6)).toEqual([3, 3]);
    expect(rowCounts(7)).toEqual([3, 2, 2]);
    expect(rowCounts(8)).toEqual([3, 3, 2]);
    expect(rowCounts(9)).toEqual([3, 3, 3]);
    expect(rowCounts(12)).toEqual([4, 4, 4]);
  });
  it('returns [] for zero', () => {
    expect(rowCounts(0)).toEqual([]);
  });
});

describe('paneRows', () => {
  it('returns no rows for an empty list', () => {
    expect(paneRows([])).toEqual([]);
  });
  it('one pane → one row of one', () => {
    expect(paneRows(['a'])).toEqual([['a']]);
  });
  it('two panes → one row of two', () => {
    expect(paneRows(['a', 'b'])).toEqual([['a', 'b']]);
  });
  it('three panes → [a,b] on top, [c] on the bottom', () => {
    expect(paneRows(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
  });
  it('six panes → a clean 3×2', () => {
    expect(paneRows(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });
  it('INVARIANT: every session placed exactly once, in order', () => {
    for (let n = 1; n <= 20; n++) {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      const flat = paneRows(ids).flat();
      expect(flat).toEqual(ids);
    }
  });
});

describe('shapeSignature', () => {
  it('matches when the row/column shape is identical', () => {
    expect(shapeSignature(['a', 'b', 'c'])).toBe('2x1');
    expect(shapeSignature(['x', 'y', 'z'])).toBe('2x1');
    expect(shapeSignature(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('3x3');
  });
  it('differs when the pane count changes the shape', () => {
    expect(shapeSignature(['a', 'b'])).not.toBe(shapeSignature(['a', 'b', 'c']));
  });
});
