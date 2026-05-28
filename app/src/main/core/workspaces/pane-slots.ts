import type Database from 'better-sqlite3';

interface PaneIndexRow {
  pane_index: number | null;
  status: string;
}

export function lowestFreePaneIndex(indexes: Iterable<number>): number {
  const occupied = new Set<number>();
  for (const index of indexes) {
    if (Number.isInteger(index) && index >= 0) {
      occupied.add(index);
    }
  }
  let candidate = 0;
  while (occupied.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

export function allocateLowestFreeLivePaneIndex(
  db: Database.Database,
  workspaceId: string,
): number {
  const rows = db
    .prepare(
      `SELECT pane_index, status
       FROM agent_sessions
       WHERE workspace_id = ?
         AND pane_index IS NOT NULL
         AND status IN ('running', 'starting')
       ORDER BY pane_index ASC`,
    )
    .all(workspaceId) as PaneIndexRow[];
  return lowestFreePaneIndex(
    rows
      .filter((row) => row.status === 'running' || row.status === 'starting')
      .map((row) => row.pane_index)
      .filter((index): index is number => index !== null),
  );
}
