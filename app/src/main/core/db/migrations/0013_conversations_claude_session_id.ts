// v1.4.0 — persist the Claude CLI session id for assistant conversations.
//
// Nullable by design: existing conversations and failed captures simply stay
// non-resumable. The assistant runtime overwrites this value when a fresh
// Claude `system.init` envelope yields a new session id.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0013_conversations_claude_session_id';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'conversations', 'claude_session_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN claude_session_id TEXT');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
