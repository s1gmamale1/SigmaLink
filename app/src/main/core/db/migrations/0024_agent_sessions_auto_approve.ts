// SF-8 Yolo/Bypass launch mode — add `auto_approve` column to agent_sessions.
//
// A plain pane can now be launched in "Yolo / Bypass" mode, where the
// provider's bypass flag (--dangerously-skip-permissions, --yolo, etc.) is
// appended to the spawn args. The flag is persisted here so that a workspace
// resume re-applies it without requiring the renderer to re-submit the flag
// from its own state.
//
// Schema change:
//   agent_sessions.auto_approve  INTEGER NOT NULL DEFAULT 0
//   0 = normal mode (default)
//   1 = bypass mode
//
// A single ALTER TABLE with a DEFAULT value is applied outside any explicit
// transaction. SQLite applies ALTER TABLE ADD COLUMN atomically on its own.
// (Per the H-7 note in migrate.ts: migrations that nest BEGIN inside the
// runner's own transaction crash fresh-DB startup, so this migration runs
// its DDL without an explicit transaction wrapper.)

import type Database from 'better-sqlite3';

export const name = '0024_agent_sessions_auto_approve';

// db.exec is the better-sqlite3 synchronous SQL runner — see migrate.ts pattern.
export function up(db: Database.Database): void {
  db.exec(
    `ALTER TABLE agent_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;`,
  );
}
