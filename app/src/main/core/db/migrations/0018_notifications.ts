// v1.4.9 #07 — Notifications system + top-right bell.
//
// Adds the `notifications` table that backs the bell dropdown in the top bar.
// Three real-time sources feed rows in: PTY exits, swarm broadcasts (gated on
// `payload.broadcastToSidebar`), and Sigma Assistant tool errors. The schema
// is irreversible (forward-only migration policy); see
// `docs/03-plan/v1.4.8-bundle/07-notifications-bell.md` §3 for the locked SQL.
//
// Columns of note:
//   - `workspace_id` is NULLABLE so app-global events (auth invalid, sync
//     conflicts) can live alongside per-workspace rows.
//   - `dedup_key` is the source-supplied collapse tuple (D3) and is NOT NULL —
//     callers must always provide one.
//   - `dup_count` defaults to 1; the manager increments it inside the 30s
//     dedup window without inserting a new row.
//   - `read_at` is per-row (D4); the badge derives from `WHERE read_at IS NULL`.
//
// Three indexes:
//   - `idx_notifications_workspace`: dropdown list paged scan.
//   - `idx_notifications_unread`: bell badge count + mark-all-read.
//   - `idx_notifications_dedup`: hot-path lookup on every add() inside the
//     30s window; partial-indexed on `read_at IS NULL` to stay small.
//
// Idempotent per the 0014/0015/0017 pattern — re-running after a partial
// failure (or in tests that call `up` repeatedly) is safe.

import type Database from 'better-sqlite3';

interface TableRow {
  name: string;
}

interface IndexRow {
  name: string;
}

function hasTable(db: Database.Database, table: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .all(table) as TableRow[];
  return rows.length > 0;
}

function hasIndex(db: Database.Database, indexName: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .all(indexName) as IndexRow[];
  return rows.length > 0;
}

export const name = '0018_notifications';

export function up(db: Database.Database): void {
  if (!hasTable(db, 'notifications')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        body TEXT,
        payload TEXT,
        source_event TEXT,
        dedup_key TEXT NOT NULL,
        dup_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      )
    `);
  }
  if (!hasIndex(db, 'idx_notifications_workspace')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_notifications_workspace
        ON notifications(workspace_id, created_at DESC)`,
    );
  }
  if (!hasIndex(db, 'idx_notifications_unread')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON notifications(read_at) WHERE read_at IS NULL`,
    );
  }
  if (!hasIndex(db, 'idx_notifications_dedup')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_notifications_dedup
        ON notifications(workspace_id, dedup_key, created_at DESC) WHERE read_at IS NULL`,
    );
  }
}
