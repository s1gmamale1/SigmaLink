// v1.1.3 Step 3 — persist the provider-native session id emitted by agent
// CLIs so panes can be relaunched with each provider's `resumeArgs`.
//
// Nullable by design: old rows and providers that do not expose a stable
// external id remain resumable=false without requiring a backfill.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0011_agent_session_external_id';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'agent_sessions', 'external_session_id')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN external_session_id TEXT');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
