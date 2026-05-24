// C-7 — Conflict-aware pane merge order.
//
// Pure utility: given a list of pane changes (session + changed-file set),
// returns the session IDs sorted by ascending total pairwise file-overlap
// (fewest conflicts first). Ties preserve input order (stable sort).

export interface PaneChange {
  sessionId: string;
  changedFiles: string[];
}

/**
 * Returns session IDs sorted by ascending total pairwise file-overlap count.
 * A pane's score is the sum of intersection sizes with every other pane.
 * Panes with score 0 (disjoint) keep their relative input order.
 * Pure function — no side effects, no imports.
 */
export function proposeMergeOrder(panes: PaneChange[]): string[] {
  if (panes.length === 0) return [];

  // Compute pairwise overlap score for each pane.
  const scores = panes.map((pane, i) => {
    const fileSet = new Set(pane.changedFiles);
    let overlapTotal = 0;
    for (let j = 0; j < panes.length; j++) {
      if (j === i) continue;
      for (const f of panes[j].changedFiles) {
        if (fileSet.has(f)) overlapTotal++;
      }
    }
    return { sessionId: pane.sessionId, score: overlapTotal, index: i };
  });

  // Stable sort: ascending score, ties keep original index order.
  scores.sort((a, b) => a.score - b.score || a.index - b.index);

  return scores.map((s) => s.sessionId);
}
