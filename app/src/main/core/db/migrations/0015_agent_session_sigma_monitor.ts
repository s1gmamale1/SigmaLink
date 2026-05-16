import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0015_agent_session_sigma_monitor';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'agent_sessions', 'sigma_monitor_conversation_id')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN sigma_monitor_conversation_id TEXT');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
