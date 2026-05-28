// v1.5.0 packet 09 — Cross-machine session sync (e2ee, git-backed).
//
// Adds six sync support tables:
//   - sync_state: per-row HLC (Hybrid Logical Clock) tracker + dirty flag
//   - sync_conflicts: LWW losers awaiting user review (stores both row JSON snapshots)
//   - sync_history: audit log of remote writes applied (GC'd after 30d)
//   - sync_quarantine: blobs that failed AEAD decrypt or structural validation
//   - sync_pending_upgrade: blobs from a newer schema version, queued until upgrade
//   - sync_tombstones: row-deletion markers (GC'd after 30d)
//
// NO plaintext content is stored in sync_* metadata tables — only row
// pointers, packed HLC timestamps, and JSON snapshots of conflicting rows
// (sync_conflicts only). The sync engine reads + encrypts row bodies from
// the actual application tables.
//
// Idempotent per the 0014/0015/0017/0018 pattern.

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

export const name = '0019_sync_metadata';

export function up(db: Database.Database): void {
  if (!hasTable(db, 'sync_state')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        table_name        TEXT NOT NULL,
        row_id            TEXT NOT NULL,
        hlc_wall_ms       INTEGER NOT NULL,
        hlc_logical       INTEGER NOT NULL,
        hlc_machine_id    BLOB    NOT NULL,
        row_hash          TEXT    NOT NULL,
        dirty             INTEGER NOT NULL DEFAULT 0,
        last_pushed_at    INTEGER,
        PRIMARY KEY (table_name, row_id)
      )
    `);
  }

  if (!hasIndex(db, 'idx_sync_state_dirty')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sync_state_dirty
        ON sync_state(dirty) WHERE dirty = 1`,
    );
  }

  if (!hasTable(db, 'sync_conflicts')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id                 TEXT PRIMARY KEY,
        table_name         TEXT NOT NULL,
        row_id             TEXT NOT NULL,
        local_hlc_packed   BLOB NOT NULL,
        remote_hlc_packed  BLOB NOT NULL,
        remote_machine_id  BLOB NOT NULL,
        local_row_json     TEXT NOT NULL,
        remote_row_json    TEXT NOT NULL,
        resolved           INTEGER NOT NULL DEFAULT 0,
        resolution         TEXT,
        resolved_at        INTEGER,
        created_at         INTEGER NOT NULL
      )
    `);
  }

  if (!hasIndex(db, 'idx_sync_conflicts_unresolved')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unresolved
        ON sync_conflicts(resolved, created_at DESC)`,
    );
  }

  if (!hasTable(db, 'sync_history')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_history (
        id           TEXT PRIMARY KEY,
        table_name   TEXT NOT NULL,
        row_id       TEXT NOT NULL,
        applied_at   INTEGER NOT NULL,
        source       TEXT NOT NULL
      )
    `);
  }

  if (!hasIndex(db, 'idx_sync_history_applied')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sync_history_applied
        ON sync_history(applied_at DESC)`,
    );
  }

  if (!hasTable(db, 'sync_quarantine')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_quarantine (
        id           TEXT PRIMARY KEY,
        blob_path    TEXT NOT NULL,
        reason       TEXT NOT NULL,
        detected_at  INTEGER NOT NULL
      )
    `);
  }

  if (!hasTable(db, 'sync_pending_upgrade')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_pending_upgrade (
        id              TEXT PRIMARY KEY,
        blob_path       TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        queued_at       INTEGER NOT NULL
      )
    `);
  }

  if (!hasTable(db, 'sync_tombstones')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_tombstones (
        table_name   TEXT NOT NULL,
        row_id       TEXT NOT NULL,
        deleted_at   INTEGER NOT NULL,
        hlc_packed   BLOB NOT NULL,
        PRIMARY KEY (table_name, row_id)
      )
    `);
  }

  if (!hasIndex(db, 'idx_sync_tombstones_gc')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sync_tombstones_gc
        ON sync_tombstones(deleted_at)`,
    );
  }
}
