// 0037 — Add closed_at soft-delete column to agent_sessions.
//
// Root cause: a manually-closed pane wrote nothing the boot read-paths exclude,
// so it resurrected on restart, and its async pty-exit raised a spurious toast.
// closed_at (epoch-ms) is the DURABLE deliberate-close marker (NULL = open). It
// is checked by the exit-notification source (suppress toast) and by both boot
// read-paths (listForWorkspace / listEligibleRows / listRespawnableRows) to
// exclude closed panes. status is NOT used for this — the late onExit DB write
// can overwrite status (running → 'error', code 143) after a kill.
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0037_agent_sessions_closed_at';

export function up(db: Database.Database): void {
  // Nullable INTEGER: NULL = open; epoch-ms = deliberately closed.
  db.exec(`ALTER TABLE agent_sessions ADD COLUMN closed_at INTEGER`);
  // Composite index for the Recents query:
  //   WHERE workspace_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC
  db.exec(
    `CREATE INDEX IF NOT EXISTS agent_sessions_closed_idx` +
      ` ON agent_sessions (workspace_id, closed_at)`,
  );
}
