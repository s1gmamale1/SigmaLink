// V3-W13-014 — Multi-hub constellation: `swarm_agents.coordinatorId`.
//
// Forward-only. Adds a self-referential FK column on `swarm_agents` that
// points each non-queen agent at its assigned coordinator. The first
// coordinator in a swarm (the "queen") gets `coordinator_id = NULL`; every
// other agent — including peer coordinators in Team/Battalion presets — is
// assigned to that queen so the constellation renderer (V3-W13-005) can draw
// glow lines only between a coordinator and its assignees.
//
// SQLite cannot ADD COLUMN with a REFERENCES clause that fires FK actions,
// but a plain TEXT column with logical FK semantics is sufficient: the
// factory enforces the link at insert time, and we never DELETE coordinators
// without killing the whole swarm.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0005_coordinator_id';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'swarm_agents', 'coordinator_id')) {
      db.exec('ALTER TABLE swarm_agents ADD COLUMN coordinator_id TEXT');
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS swarm_agents_coord_idx ON swarm_agents (coordinator_id);`,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
