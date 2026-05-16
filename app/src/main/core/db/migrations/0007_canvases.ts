// V3-W14-006 — Sigma Canvas persistence.
//
// Adds two tables that back the Canvas surface:
//
//   canvases             — one row per visual-design workspace. Title +
//                          last-used provider list (JSON array).
//   canvas_dispatches    — append-only log of design dispatch events for the
//                          `design.history` RPC. Captures the prompt, the
//                          provider fan-out, and a timestamp.
//
// Forward-only. Idempotent via `CREATE TABLE IF NOT EXISTS`. Re-running on a
// DB that already has these tables is a no-op; the runner records success in
// `schema_migrations` regardless so future boots skip this entirely.
//
// CASCADE delete on `canvas_dispatches.canvas_id` keeps the history table
// self-cleaning when an operator drops a canvas.

import type Database from 'better-sqlite3';

export const name = '0007_canvases';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS canvases (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        last_providers TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS canvases_ws_idx ON canvases(workspace_id);

      CREATE TABLE IF NOT EXISTS canvas_dispatches (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        providers TEXT NOT NULL DEFAULT '[]',
        ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS canvas_dispatches_canvas_idx
        ON canvas_dispatches(canvas_id, ts);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
