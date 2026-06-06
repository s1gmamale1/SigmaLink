// BSP-O4 — persist an operator-chosen display name per agent session.
//
// The `name` column is nullable TEXT. NULL means "use the computed alias";
// a non-null string is the operator-supplied label shown in the title pill.
// Migration pattern mirrors 0035: idempotent PRAGMA guard (no self-BEGIN).

import type Database from 'better-sqlite3';

export const name = '0036_agent_sessions_name';

export function up(db: Database.Database): void {
  // Idempotent guard — mirror 0035 pattern.
  const cols = db
    .prepare(`PRAGMA table_info(agent_sessions)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'name')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN name TEXT;`);
  }
}
