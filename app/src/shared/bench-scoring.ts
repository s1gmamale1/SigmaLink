// C-12 SigmaBench — pure conflict scoring.
//
// Given the per-pane changed-file sets produced by a multi-agent run, return
// each session's conflict score: the total number of file-overlaps it has
// with every OTHER pane. A score of 0 means the pane is fully disjoint from
// the rest (the most-isolated, best outcome — the whole point of the
// "worktree-swarm = no merge conflicts" thesis we benchmark).
//
// The overlap arithmetic is intentionally identical to proposeMergeOrder
// (merge-order.ts): for pane i we sum, over every other pane j, the count of
// j's files that also appear in i's set. Duplicate filenames within a single
// pane are de-duplicated via a Set before counting, matching merge-order.

import type { PaneChange } from './merge-order';

export interface ConflictScore {
  sessionId: string;
  conflictScore: number;
}

/**
 * Compute the pairwise file-overlap score for each pane. Pure — no I/O, no
 * mutation of the input. Order of the result mirrors the input order.
 */
export function scoreConflicts(panes: PaneChange[]): ConflictScore[] {
  return panes.map((pane, i) => {
    const fileSet = new Set(pane.changedFiles);
    let conflictScore = 0;
    for (let j = 0; j < panes.length; j++) {
      if (j === i) continue;
      for (const f of panes[j].changedFiles) {
        if (fileSet.has(f)) conflictScore++;
      }
    }
    return { sessionId: pane.sessionId, conflictScore };
  });
}
