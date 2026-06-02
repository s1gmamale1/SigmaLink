// P6 FEAT-11 — agent undo/rewind via per-pane worktree git checkpoints.
//
// Each row records a checkpoint commit on a pane's own (throwaway) worktree
// branch:
//   session_checkpoints(
//     id         TEXT PK,
//     session_id TEXT NOT NULL,   -- agent_sessions.id this checkpoint belongs to
//     sha        TEXT NOT NULL,   -- the commit sha created in the worktree
//     label      TEXT,            -- operator label or NULL ('pre-rewind' for autos)
//     kind       TEXT NOT NULL,   -- 'manual' (operator) | 'auto' (pre-rewind safety)
//     created_at INTEGER NOT NULL -- epoch ms
//   )
// plus an index on session_id so the rewind panel's
//   SELECT … WHERE session_id = ? ORDER BY created_at DESC
// read-path is index-backed.
//
// H-7: NO db.transaction(), BEGIN, COMMIT, or ROLLBACK here — the migration
// runner (migrate.ts) already wraps each migration's up() in ONE transaction;
// a nested BEGIN throws "cannot start a transaction within a transaction" and
// crashes fresh-DB startup. Each statement below is a plain db.exec. The static
// guard in __tests__/migrate.spec.ts enforces the no-self-BEGIN rule.
//
// Idempotent: CREATE TABLE / CREATE INDEX both use IF NOT EXISTS.

import type Database from 'better-sqlite3';

export const name = '0028_session_checkpoints';

// `db.exec` below is the better-sqlite3 SQL runner — NOT child_process.exec.
export function up(db: Database.Database): void {
  const run = (sql: string) => db.exec(sql);
  run(`
    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id         TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL,
      sha        TEXT NOT NULL,
      label      TEXT,
      kind       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  run(`
    CREATE INDEX IF NOT EXISTS session_checkpoints_session_idx
      ON session_checkpoints(session_id)
  `);
}
