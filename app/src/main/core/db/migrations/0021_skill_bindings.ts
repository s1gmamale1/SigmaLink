// v1.7.1 W-5 Skills Phase 2 — Skill-binding persistence (INFORMATIONAL only).
//
// Creates `skill_bindings`: a table that records a visual association between
// a skill (identified by name + source) and either a whole workspace or a
// single pane session inside that workspace.
//
// SCOPE NOTE: This is INFORMATIONAL binding only. Attaching a skill to a
// pane/workspace creates a persisted visual chip shown in the UI. It does NOT
// alter agent dispatch, does NOT inject anything into agent context, and does
// NOT change Sigma/Jorvis tool-calling. Behavioral activation (skill actually
// affecting agent context) is a separate future enhancement requiring design
// decisions and is explicitly OUT OF SCOPE for this migration.
//
// Schema:
//   skill_bindings(
//     id              TEXT PK,
//     workspace_id    TEXT NOT NULL,
//     pane_session_id TEXT NULL,   -- NULL = workspace-wide; non-null = pane-scoped
//     skill_name      TEXT NOT NULL,
//     skill_source    TEXT NOT NULL,
//     attached_at     INTEGER NOT NULL
//   )
//
// Indexes:
//   skill_bindings_ws_idx — speeds up listBindings(workspaceId) lookups
//
// Dedup: application layer enforces (workspace_id, pane_session_id, skill_name,
// skill_source) uniqueness via INSERT OR IGNORE so the table stays clean.
//
// Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

import type Database from 'better-sqlite3';

export const name = '0021_skill_bindings';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_bindings (
        id              TEXT NOT NULL PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        pane_session_id TEXT,
        skill_name      TEXT NOT NULL,
        skill_source    TEXT NOT NULL,
        attached_at     INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS skill_bindings_ws_idx
        ON skill_bindings(workspace_id)
    `);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
