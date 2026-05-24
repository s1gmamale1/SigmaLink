// C-12 SigmaBench — tests for the pure conflict-scoring function.
//
// scoreConflicts mirrors the pairwise file-overlap logic that
// proposeMergeOrder (merge-order.ts) uses, but surfaces the raw per-pane
// score instead of a sorted order. A score of 0 means the pane's changed
// files are disjoint from every other pane (the most-isolated, best result).

import { describe, expect, it } from 'vitest';
import { scoreConflicts } from './bench-scoring';
import type { PaneChange } from './merge-order';

describe('scoreConflicts', () => {
  it('returns an empty array for no panes', () => {
    expect(scoreConflicts([])).toEqual([]);
  });

  it('scores every pane 0 when all file sets are disjoint', () => {
    const panes: PaneChange[] = [
      { sessionId: 'a', changedFiles: ['src/a.ts'] },
      { sessionId: 'b', changedFiles: ['src/b.ts'] },
      { sessionId: 'c', changedFiles: ['src/c.ts', 'src/c2.ts'] },
    ];
    expect(scoreConflicts(panes)).toEqual([
      { sessionId: 'a', conflictScore: 0 },
      { sessionId: 'b', conflictScore: 0 },
      { sessionId: 'c', conflictScore: 0 },
    ]);
  });

  it('scores each of two panes sharing one file as 1', () => {
    const panes: PaneChange[] = [
      { sessionId: 'a', changedFiles: ['src/shared.ts', 'src/a.ts'] },
      { sessionId: 'b', changedFiles: ['src/shared.ts', 'src/b.ts'] },
    ];
    expect(scoreConflicts(panes)).toEqual([
      { sessionId: 'a', conflictScore: 1 },
      { sessionId: 'b', conflictScore: 1 },
    ]);
  });

  it('sums overlaps across every other pane', () => {
    // `x` shares 1 file with `a` and 1 file with `b` => score 2.
    // `a` shares only with `x` => 1. `b` shares only with `x` => 1.
    const panes: PaneChange[] = [
      { sessionId: 'a', changedFiles: ['src/one.ts'] },
      { sessionId: 'b', changedFiles: ['src/two.ts'] },
      { sessionId: 'x', changedFiles: ['src/one.ts', 'src/two.ts'] },
    ];
    expect(scoreConflicts(panes)).toEqual([
      { sessionId: 'a', conflictScore: 1 },
      { sessionId: 'b', conflictScore: 1 },
      { sessionId: 'x', conflictScore: 2 },
    ]);
  });

  it('counts a file shared by three panes from each pane perspective', () => {
    // All three touch `src/dup.ts`. Each pane overlaps with 2 others => 2.
    const panes: PaneChange[] = [
      { sessionId: 'a', changedFiles: ['src/dup.ts'] },
      { sessionId: 'b', changedFiles: ['src/dup.ts'] },
      { sessionId: 'c', changedFiles: ['src/dup.ts'] },
    ];
    expect(scoreConflicts(panes)).toEqual([
      { sessionId: 'a', conflictScore: 2 },
      { sessionId: 'b', conflictScore: 2 },
      { sessionId: 'c', conflictScore: 2 },
    ]);
  });
});
