// 0039 — Mission board: missions / mission_tasks / mission_events.
//
// The data layer of the Jorvis Persistent Operator arc (Phase 20). A mission is
// a natural-language goal decomposed into ordered task cards; the autonomous
// supervisor loop that drives them is P1b. LOCAL-ONLY (per-machine operator
// state) — deliberately NOT added to the sync allowlist.
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0039_missions';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('local','telegram','external','autonomous')),
      client_label TEXT,
      workspace_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','active','paused','done','failed','cancelled')),
      report TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('backlog','dispatched','working','reviewing','needs_input','done','blocked')),
      assignee_session_id TEXT,
      worktree_path TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      order_idx INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      task_id TEXT,
      kind TEXT NOT NULL,
      body TEXT,
      ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_tasks_mission_status_idx ON mission_tasks (mission_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_tasks_assignee_idx ON mission_tasks (assignee_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_events_mission_ts_idx ON mission_events (mission_id, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS missions_status_idx ON missions (status)`);
}
