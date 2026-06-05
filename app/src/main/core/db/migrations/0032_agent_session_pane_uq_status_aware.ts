// 0032 — ADR-005: make agent_sessions_ws_pane_uq STATUS-AWARE.
//
// Migration 0020 created this partial unique index on
// (workspace_id, pane_index) for ALL rows with pane_index IS NOT NULL,
// regardless of status. The pane-slot allocator (allocateLowestFreeLivePaneIndex)
// counts a slot occupied only for status IN ('running','starting'). The two
// disagreed: after a crash, exited rows kept pane_index and the status-agnostic
// index rejected every fresh INSERT into that slot -> permanent post-crash
// launch lockout (CRIT-2).
//
// This drops and recreates the index with the SAME predicate the allocator
// uses, so an 'exited'/'error' row no longer occupies the slot. The new
// predicate is a strict subset of the old one (it constrains FEWER rows), so
// dropping the old index can never introduce a violation the recreate rejects
// -> no dedup step is needed (unlike 0020).
//
// H-7: migrate() wraps each up() in a transaction; do NOT emit BEGIN/COMMIT.
import type Database from 'better-sqlite3';

export const name = '0032_agent_session_pane_uq_status_aware';

export function up(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS agent_sessions_ws_pane_uq`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_ws_pane_uq
      ON agent_sessions(workspace_id, pane_index)
      WHERE pane_index IS NOT NULL
        AND status IN ('running', 'starting')
  `);
}
