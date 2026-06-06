// RAM Brake — persist the per-pane runtime profile on agent_sessions.
//
// Existing rows are treated as lightweight `ruflo-core` panes. New Browser /
// security-heavy lanes persist their profile so admission control, diagnostics,
// and pane chrome can reason about them after reload.

import type Database from 'better-sqlite3';

export const name = '0035_agent_sessions_runtime_profile';

export function up(db: Database.Database): void {
  db.exec(
    `ALTER TABLE agent_sessions ADD COLUMN runtime_profile_id TEXT NOT NULL DEFAULT 'ruflo-core';`,
  );
}
