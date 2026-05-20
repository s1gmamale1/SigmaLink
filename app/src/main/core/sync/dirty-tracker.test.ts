// v1.5.0 packet 09 — DirtyTracker tests.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  isSyncable,
  hashRow,
  markDirty,
  markDeleted,
  listDirtyRows,
  markClean,
  SYNCED_TABLES,
  NEVER_SYNC_TABLES,
} from './dirty-tracker';

// ------------------------------------------------------------------
// Minimal mock DB
// ------------------------------------------------------------------

class MockDb {
  rows = new Map<string, Record<string, unknown>>();
  tombstones = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return {
      run: (...args: unknown[]) => {
        const normalised = sql.replace(/\s+/g, ' ').trim().toUpperCase();
        if (normalised.startsWith('INSERT INTO SYNC_STATE')) {
          const key = `${args[0]}:${args[1]}`;
          this.rows.set(key, { table_name: args[0], row_id: args[1], dirty: 1 });
        } else if (normalised.startsWith('UPDATE SYNC_STATE SET DIRTY = 0')) {
          const key = `${args[1]}:${args[2]}`;
          const row = this.rows.get(key);
          if (row) { row.dirty = 0; row.last_pushed_at = args[0]; }
        } else if (normalised.startsWith('UPDATE SYNC_STATE SET HLC_WALL_MS')) {
          // no-op in mock
        } else if (normalised.startsWith('INSERT OR REPLACE INTO SYNC_TOMBSTONES')) {
          const key = `${args[0]}:${args[1]}`;
          this.tombstones.set(key, { table_name: args[0], row_id: args[1] });
        } else if (normalised.startsWith('DELETE FROM SYNC_STATE')) {
          const key = `${args[0]}:${args[1]}`;
          this.rows.delete(key);
        }
      },
      all: () => Array.from(this.rows.values()).filter((r) => r.dirty === 1),
    };
  }
}

let db: MockDb;
beforeEach(() => {
  db = new MockDb();
});

describe('SYNCED_TABLES', () => {
  it('contains conversations', () => {
    expect(SYNCED_TABLES.has('conversations')).toBe(true);
  });

  it('contains memories', () => {
    expect(SYNCED_TABLES.has('memories')).toBe(true);
  });

  it('does not contain credentials', () => {
    expect(SYNCED_TABLES.has('credentials')).toBe(false);
  });
});

describe('NEVER_SYNC_TABLES', () => {
  it('contains credentials', () => {
    expect(NEVER_SYNC_TABLES.has('credentials')).toBe(true);
  });

  it('contains kv', () => {
    expect(NEVER_SYNC_TABLES.has('kv')).toBe(true);
  });
});

describe('isSyncable', () => {
  it('returns true for a synced table', () => {
    expect(isSyncable('conversations')).toBe(true);
  });

  it('returns false for an out-of-scope table', () => {
    expect(isSyncable('some_unknown_table')).toBe(false);
  });

  it('throws for credentials (HARD-DENY)', () => {
    expect(() => isSyncable('credentials')).toThrow('NEVER_SYNC_TABLES');
  });

  it('throws for kv (HARD-DENY)', () => {
    expect(() => isSyncable('kv')).toThrow('NEVER_SYNC_TABLES');
  });

  it('throws for browser_tabs (HARD-DENY)', () => {
    expect(() => isSyncable('browser_tabs')).toThrow('NEVER_SYNC_TABLES');
  });
});

describe('hashRow', () => {
  it('produces a 64-char hex string', () => {
    const h = hashRow('{"id":"1"}');
    expect(h.length).toBe(64);
  });

  it('same input → same hash', () => {
    expect(hashRow('{"a":1}')).toBe(hashRow('{"a":1}'));
  });

  it('different input → different hash', () => {
    expect(hashRow('{"a":1}')).not.toBe(hashRow('{"a":2}'));
  });
});

describe('markDirty', () => {
  it('marks a row dirty in sync_state', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = markDirty(db as any, 'conversations', 'row-1', 'aabbcc', 'hash1');
    expect(result).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dirty = listDirtyRows(db as any);
    expect(dirty.length).toBe(1);
    expect(dirty[0]?.table_name).toBe('conversations');
    expect(dirty[0]?.row_id).toBe('row-1');
  });

  it('returns false for non-synced table', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = markDirty(db as any, 'some_unknown', 'r1', 'aabb', 'h');
    expect(result).toBe(false);
  });

  it('throws for credentials (HARD-DENY)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => markDirty(db as any, 'credentials', 'r1', 'aabb', 'h')).toThrow(
      'NEVER_SYNC_TABLES',
    );
  });
});

describe('markDeleted', () => {
  it('inserts a tombstone and removes from sync_state', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markDirty(db as any, 'tasks', 'task-1', 'aabb', 'hash1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = markDeleted(db as any, 'tasks', 'task-1', 'ccdd');
    expect(result).toBe(true);
    // Row should be removed from dirty set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(listDirtyRows(db as any).length).toBe(0);
    // Tombstone should exist.
    expect(db.tombstones.has('tasks:task-1')).toBe(true);
  });

  it('returns false for non-synced table', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(markDeleted(db as any, 'unknown', 'r1', 'aabb')).toBe(false);
  });
});

describe('markClean', () => {
  it('sets dirty=0 after push', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markDirty(db as any, 'conversations', 'row-1', 'aabb', 'h');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markClean(db as any, 'conversations', 'row-1', Date.now());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(listDirtyRows(db as any).length).toBe(0);
  });
});
