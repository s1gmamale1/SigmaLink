// v1.3.1 — persist the launcher-issued `pane_index` per agent_sessions row.
//
// v1.3.0 introduced the per-pane session picker but `lastResumePlan` keyed off
// `started_at` row-number, which returned every historical row instead of one
// row per actual pane. After 3 launches of a 4-pane workspace the picker
// surfaced 12 rows → 12+ panes spawned. The fix adds an explicit `pane_index`
// integer column so the controller can group by `(workspace_id, pane_index)`
// and return the most-recent row per pane.
//
// Nullable by design: legacy rows (pre-v1.3.1) cannot be confidently mapped to
// pane slots, so they stay NULL and the controller filters them out via
// `WHERE pane_index IS NOT NULL`. The launcher writes the column on every new
// row from v1.3.1 onwards.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0012_agent_session_pane_index';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'agent_sessions', 'pane_index')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN pane_index INTEGER');
    }
    // Composite index for the lastResumePlan controller: scoped lookup +
    // ORDER BY started_at within each (workspace_id, pane_index) bucket.
    db.exec(
      'CREATE INDEX IF NOT EXISTS agent_sessions_ws_pane_idx ON agent_sessions(workspace_id, pane_index, started_at)',
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
