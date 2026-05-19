// v1.4.9 #07 — Notifications migration. Mirrors 0017's mock-db test pattern
// (no real better-sqlite3 dependency at unit-test time). Verifies:
//   - CREATE TABLE executes the locked schema (12 columns).
//   - All three indexes land.
//   - Re-running `up` is a no-op (idempotent contract).

import { describe, expect, it } from 'vitest';
import { up } from './0018_notifications';

class MockDb {
  tables = new Set<string>();
  indexes = new Set<string>();
  createTableSql = '';

  exec(sql: string): void {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return;
    const createTableMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
    if (createTableMatch) {
      this.tables.add(createTableMatch[1]);
      this.createTableSql = sql;
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

describe('0018_notifications', () => {
  it('creates the notifications table with locked column set', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    expect(db.tables.has('notifications')).toBe(true);
    // Spot-check every locked column appears in the CREATE TABLE SQL — the
    // taxonomy lock in the brief means accidentally renaming or dropping any
    // of these would break the IPC delta contract.
    const lockedColumns = [
      'id TEXT PRIMARY KEY',
      'workspace_id TEXT',
      'kind TEXT NOT NULL',
      "severity TEXT NOT NULL DEFAULT 'info'",
      'title TEXT NOT NULL',
      'body TEXT',
      'payload TEXT',
      'source_event TEXT',
      'dedup_key TEXT NOT NULL',
      'dup_count INTEGER NOT NULL DEFAULT 1',
      'created_at INTEGER NOT NULL',
      'read_at INTEGER',
    ];
    for (const col of lockedColumns) {
      expect(db.createTableSql).toContain(col);
    }
  });

  it('creates all three indexes', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);

    expect(db.indexes.has('idx_notifications_workspace')).toBe(true);
    expect(db.indexes.has('idx_notifications_unread')).toBe(true);
    expect(db.indexes.has('idx_notifications_dedup')).toBe(true);
  });

  it('is idempotent (up twice does not throw or duplicate)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);
    up(db);

    // The set semantics already enforce uniqueness, but assert the count
    // explicitly so the contract is clear in test output.
    expect(db.tables.size).toBe(1);
    expect(db.indexes.size).toBe(3);
  });
});
