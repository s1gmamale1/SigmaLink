// v1.5.0 #09 — sync_metadata migration test. Mirrors the 0018 mock-db
// pattern — no real better-sqlite3 dependency at unit-test time.
//
// Verifies:
//   - All six sync_* tables are created.
//   - Required indexes land.
//   - Re-running `up` is a no-op (idempotent contract).
//   - Column sets match the locked schema from the brief.

import { describe, expect, it } from 'vitest';
import { up } from './0019_sync_metadata';

class MockDb {
  tables = new Set<string>();
  indexes = new Set<string>();
  tableSqls = new Map<string, string>();

  exec(sql: string): void {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return;
    const createTableMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
    if (createTableMatch) {
      const tname = createTableMatch[1];
      this.tables.add(tname);
      this.tableSqls.set(tname, sql);
      return;
    }
    const createIdxMatch = sql.match(/CREATE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)/i);
    if (createIdxMatch) {
      this.indexes.add(createIdxMatch[1]);
      return;
    }
    throw new Error('Unhandled SQL: ' + sql);
  }

  prepare(sql: string) {
    if (/SELECT name FROM sqlite_master WHERE type = 'table'/i.test(sql)) {
      return {
        all: (table: string): { name: string }[] => {
          return this.tables.has(table) ? [{ name: table }] : [];
        },
      };
    }
    if (/SELECT name FROM sqlite_master WHERE type = 'index'/i.test(sql)) {
      return {
        all: (idx: string): { name: string }[] => {
          return this.indexes.has(idx) ? [{ name: idx }] : [];
        },
      };
    }
    throw new Error('Unhandled SQL: ' + sql);
  }
}

describe('0019_sync_metadata', () => {
  it('creates all six sync_* tables', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    expect(db.tables.has('sync_state')).toBe(true);
    expect(db.tables.has('sync_conflicts')).toBe(true);
    expect(db.tables.has('sync_history')).toBe(true);
    expect(db.tables.has('sync_quarantine')).toBe(true);
    expect(db.tables.has('sync_pending_upgrade')).toBe(true);
    expect(db.tables.has('sync_tombstones')).toBe(true);
  });

  it('sync_state has the locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    const sql = db.tableSqls.get('sync_state') as string;
    const locked = [
      'table_name        TEXT NOT NULL',
      'row_id            TEXT NOT NULL',
      'hlc_wall_ms       INTEGER NOT NULL',
      'hlc_logical       INTEGER NOT NULL',
      'hlc_machine_id    BLOB    NOT NULL',
      'row_hash          TEXT    NOT NULL',
      'dirty             INTEGER NOT NULL DEFAULT 0',
      'last_pushed_at    INTEGER',
    ];
    for (const col of locked) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain('PRIMARY KEY (table_name, row_id)');
  });

  it('sync_conflicts has the locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    const sql = db.tableSqls.get('sync_conflicts') as string;
    const locked = [
      'id                 TEXT PRIMARY KEY',
      'table_name         TEXT NOT NULL',
      'row_id             TEXT NOT NULL',
      'local_hlc_packed   BLOB NOT NULL',
      'remote_hlc_packed  BLOB NOT NULL',
      'remote_machine_id  BLOB NOT NULL',
      'local_row_json     TEXT NOT NULL',
      'remote_row_json    TEXT NOT NULL',
      'resolved           INTEGER NOT NULL DEFAULT 0',
      'resolution         TEXT',
      'resolved_at        INTEGER',
      'created_at         INTEGER NOT NULL',
    ];
    for (const col of locked) {
      expect(sql).toContain(col);
    }
  });

  it('sync_tombstones has the locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    const sql = db.tableSqls.get('sync_tombstones') as string;
    expect(sql).toContain('table_name   TEXT NOT NULL');
    expect(sql).toContain('row_id       TEXT NOT NULL');
    expect(sql).toContain('deleted_at   INTEGER NOT NULL');
    expect(sql).toContain('hlc_packed   BLOB NOT NULL');
    expect(sql).toContain('PRIMARY KEY (table_name, row_id)');
  });

  it('sync_quarantine has the locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    const sql = db.tableSqls.get('sync_quarantine') as string;
    expect(sql).toContain('id           TEXT PRIMARY KEY');
    expect(sql).toContain('blob_path    TEXT NOT NULL');
    expect(sql).toContain('reason       TEXT NOT NULL');
    expect(sql).toContain('detected_at  INTEGER NOT NULL');
  });

  it('sync_pending_upgrade has the locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    const sql = db.tableSqls.get('sync_pending_upgrade') as string;
    expect(sql).toContain('id              TEXT PRIMARY KEY');
    expect(sql).toContain('blob_path       TEXT NOT NULL');
    expect(sql).toContain('schema_version  INTEGER NOT NULL');
    expect(sql).toContain('queued_at       INTEGER NOT NULL');
  });

  it('sync_history has the locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    const sql = db.tableSqls.get('sync_history') as string;
    expect(sql).toContain('id           TEXT PRIMARY KEY');
    expect(sql).toContain('table_name   TEXT NOT NULL');
    expect(sql).toContain('row_id       TEXT NOT NULL');
    expect(sql).toContain('applied_at   INTEGER NOT NULL');
    expect(sql).toContain('source       TEXT NOT NULL');
  });

  it('creates the required indexes', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    expect(db.indexes.has('idx_sync_state_dirty')).toBe(true);
    expect(db.indexes.has('idx_sync_conflicts_unresolved')).toBe(true);
    expect(db.indexes.has('idx_sync_history_applied')).toBe(true);
    expect(db.indexes.has('idx_sync_tombstones_gc')).toBe(true);
  });

  it('is idempotent (up twice does not throw or duplicate tables)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);
    up(db);

    expect(db.tables.size).toBe(6);
    // 4 indexes from migration
    expect(db.indexes.size).toBe(4);
  });
});
