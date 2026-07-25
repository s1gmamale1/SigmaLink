// Notification reliability workstream 1 — persisted ordering token for
// snapshots and committed change sets. The migration runner owns atomicity;
// this file must not issue its own transaction statements.

import type Database from 'better-sqlite3';

export const name = '0043_notification_state_revision';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    )
  `);
  db.prepare(
    `INSERT OR IGNORE INTO notification_state (singleton, revision)
     VALUES (1, 0)`,
  ).run();
}
