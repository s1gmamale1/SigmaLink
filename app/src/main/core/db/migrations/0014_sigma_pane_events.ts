import type Database from 'better-sqlite3';

export const name = '0014_sigma_pane_events';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sigma_pane_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT,
        ts INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS sigma_pane_events_conv_ts ON sigma_pane_events(conversation_id, ts DESC)
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
