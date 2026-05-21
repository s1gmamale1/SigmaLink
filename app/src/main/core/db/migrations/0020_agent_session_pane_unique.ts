// v1.5.5 Cluster A — UNIQUE constraint on agent_sessions(workspace_id, pane_index).
//
// Problem: the existing composite index `agent_sessions_ws_pane_idx` is a
// plain (non-unique) index, so a concurrent rapid-spawn race can insert two
// rows for the same (workspace_id, pane_index) slot. The `panes.lastResumePlan`
// controller de-dupes via ORDER BY started_at but the DB itself offers no
// integrity guarantee.
//
// This migration:
//   1. Deduplications any existing duplicate rows, keeping the most-recent
//      `started_at` per (workspace_id, pane_index) pair (older dupes are
//      deleted).  We skip rows where pane_index IS NULL — those are legacy /
//      swarm sessions without a pane slot and must not be touched.
//   2. Creates a PARTIAL unique index `agent_sessions_ws_pane_uq` that only
//      covers rows where pane_index IS NOT NULL, so NULL rows (pre-v1.3.1 and
//      swarm sessions) don't collide.
//
// Idempotent: re-running is safe.  The dedup DELETE uses a self-join
// ("keep me if no other row with the same slot has a higher started_at"), so a
// second run finds nothing to delete and the index DDL is `CREATE UNIQUE INDEX
// IF NOT EXISTS`.

import type Database from 'better-sqlite3';

interface IndexRow {
  name: string;
}

function hasIndex(db: Database.Database, indexName: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .all(indexName) as IndexRow[];
  return rows.length > 0;
}

export const name = '0020_agent_session_pane_unique';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    // Step 1 — Deduplicate existing rows.
    // For each (workspace_id, pane_index) group where pane_index IS NOT NULL,
    // delete every row that is NOT the latest (highest started_at).  When two
    // rows share the same started_at, we keep the one with the lexicographically
    // higher `id` as a tie-breaker (both are equally good; we just need one winner).
    db.exec(`
      DELETE FROM agent_sessions
      WHERE pane_index IS NOT NULL
        AND id NOT IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY workspace_id, pane_index
                     ORDER BY started_at DESC, id DESC
                   ) AS rn
            FROM agent_sessions
            WHERE pane_index IS NOT NULL
          ) ranked
          WHERE rn = 1
        )
    `);

    // Step 2 — Create the partial unique index.
    if (!hasIndex(db, 'agent_sessions_ws_pane_uq')) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_ws_pane_uq
          ON agent_sessions(workspace_id, pane_index)
          WHERE pane_index IS NOT NULL
      `);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
