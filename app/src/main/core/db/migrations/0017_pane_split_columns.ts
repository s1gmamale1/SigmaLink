// v1.4.3 #06 — Pane Split + Minimise feature columns.
//
// Adds four nullable columns to `agent_sessions` so a swarm pane can be
// annotated as part of a split group (max 2-level deep in v1.4.x) and/or
// collapsed to its header strip. The columns are nullable (split_group_id,
// split_direction, split_index) or default 0 (minimised) so legacy rows
// continue to render as standalone, non-minimised panes without backfill.
//
// Composite index `agent_sessions_split_idx` on (workspace_id, split_group_id)
// lets the renderer cheaply gather every sub-pane of a split group when
// laying out the grid.
//
// Idempotent per the 0014/0015 pattern — re-running the migration after a
// partial failure (or in tests that call `up` multiple times) is safe.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

interface IndexRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

function hasIndex(db: Database.Database, indexName: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .all(indexName) as IndexRow[];
  return rows.length > 0;
}

export const name = '0017_pane_split_columns';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'agent_sessions', 'split_group_id')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN split_group_id TEXT');
    }
    if (!hasColumn(db, 'agent_sessions', 'split_direction')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN split_direction TEXT');
    }
    if (!hasColumn(db, 'agent_sessions', 'split_index')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN split_index INTEGER');
    }
    if (!hasColumn(db, 'agent_sessions', 'minimised')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN minimised INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasIndex(db, 'agent_sessions_split_idx')) {
      db.exec(
        'CREATE INDEX IF NOT EXISTS agent_sessions_split_idx ON agent_sessions(workspace_id, split_group_id)',
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
