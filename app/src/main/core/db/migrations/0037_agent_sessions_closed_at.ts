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

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((row) => row.name === column);
}

export function up(db: Database.Database): void {
  // Cross-process migrate re-run guard (contract: client.ts bootstrapAndMigrate
  // — "the migration runner short-circuits via PRAGMA introspection"). The MCP
  // memory-server child process also runs migrate() against this same DB file
  // (core/memory/mcp-server.ts); the per-migration txn serializes writers, but
  // the loser read its `applied` set before the winner committed, so it can
  // re-attempt this migration — a bare ALTER throws `duplicate column name`;
  // this guard makes the re-run a no-op (mirrors 0035).
  if (!hasColumn(db, 'agent_sessions', 'closed_at')) {
    // Nullable INTEGER: NULL = open; epoch-ms = deliberately closed.
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN closed_at INTEGER`);
  }
  // Composite index for the Recents query:
  //   WHERE workspace_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC
  // full (non-partial) index — keeps the drizzle mirror exact; NULL-row bloat
  // is negligible at this cardinality. IF NOT EXISTS self-guards the re-run.
  db.exec(
    `CREATE INDEX IF NOT EXISTS agent_sessions_closed_idx` +
      ` ON agent_sessions (workspace_id, closed_at)`,
  );
}
