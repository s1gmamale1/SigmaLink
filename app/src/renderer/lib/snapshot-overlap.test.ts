import { describe, expect, it } from 'vitest';
import { computeSnapshotOverlap, MAX_OVERLAP_SCAN } from './snapshot-overlap';

describe('computeSnapshotOverlap', () => {
  it('finds the longest snapshot-tail / pending-head overlap', () => {
    expect(computeSnapshotOverlap('abcdef', 'defghi')).toBe(3);
  });
  it('returns 0 when there is no overlap or either side is empty', () => {
    expect(computeSnapshotOverlap('abc', 'xyz')).toBe(0);
    expect(computeSnapshotOverlap('', 'abc')).toBe(0);
    expect(computeSnapshotOverlap('abc', '')).toBe(0);
  });
  it('full containment: pending entirely inside the snapshot tail', () => {
    expect(computeSnapshotOverlap('xxabc', 'abc')).toBe(3);
  });
  it('caps the scan window', () => {
    expect(MAX_OVERLAP_SCAN).toBe(65_536);
  });
});
