import { describe, it, expect } from 'vitest';
import { rowCounts, gridShape } from './pane-grid-shape';

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

describe('gridShape', () => {
  it('returns an empty shape for no sessions', () => {
    expect(gridShape([])).toEqual({ cols: 1, rows: 1, cells: [] });
  });

  it('one pane fills the whole grid', () => {
    expect(gridShape(['a'])).toEqual({ cols: 1, rows: 1, cells: [{ sessionId: 'a', colSpan: 1 }] });
  });

  it('two panes split into one row of two', () => {
    const s = gridShape(['a', 'b']);
    expect(s).toEqual({ cols: 2, rows: 1, cells: [
      { sessionId: 'a', colSpan: 1 },
      { sessionId: 'b', colSpan: 1 },
    ] });
  });

  it('three panes: 2 on top, 1 spanning the full bottom (no dead space)', () => {
    const s = gridShape(['a', 'b', 'c']);
    expect(s.cols).toBe(2);
    expect(s.rows).toBe(2);
    expect(s.cells).toEqual([
      { sessionId: 'a', colSpan: 1 },
      { sessionId: 'b', colSpan: 1 },
      { sessionId: 'c', colSpan: 2 }, // bottom row widens to fill
    ]);
  });

  it('six panes form a clean 3×2 grid', () => {
    const s = gridShape(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(s.cols).toBe(3);
    expect(s.rows).toBe(2);
    expect(s.cells.every((c) => c.colSpan === 1)).toBe(true);
    expect(s.cells.map((c) => c.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('INVARIANT: every row of cells sums to exactly `cols` (perfect fill, no dead space)', () => {
    for (let n = 1; n <= 20; n++) {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      const { cols, cells } = gridShape(ids);
      const counts = rowCounts(n);
      let idx = 0;
      for (const count of counts) {
        const rowSpan = cells.slice(idx, idx + count).reduce((sum, c) => sum + c.colSpan, 0);
        expect(rowSpan).toBe(cols);
        idx += count;
      }
      expect(cells).toHaveLength(n); // every session placed exactly once
    }
  });
});
