// V1.1-02 — BridgeCode launcher writes the resolved provider tag to
// `agent_sessions.provider_effective` (e.g. 'claude' when the session was
// launched via the Claude CLI bridge). The CHANGELOG and V3_PARITY_BACKLOG
// promised this column ship in Phase 2 but the migration was never authored,
// leaving the schema drifted from the launcher façade. This is the catch-up
// migration: forward-only, nullable, idempotent.
//
// Why nullable? Existing rows predate the launcher tag and have no truthful
// value to backfill. The launcher will populate new rows going forward via
// `getProviderEffectiveFromLauncherFaçade(...)`.
//
// SQLite cannot ADD COLUMN with a CHECK constraint that references existing
// rows; a plain TEXT column with launcher-side validation is sufficient.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0010_provider_effective';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'agent_sessions', 'provider_effective')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN provider_effective TEXT');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
