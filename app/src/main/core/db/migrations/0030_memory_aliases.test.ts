// P4.2 MEM-5 — tests for migration 0030_memory_aliases.
//
// better-sqlite3 cannot load under vitest (built for Electron's ABI), so we use
// a MockDb that models PRAGMA table_info + ALTER TABLE ADD COLUMN and assert on
// the column the migration adds + its idempotency guard.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0030_memory_aliases';

interface ColRow {
  name: string;
}

class MockDb {
  // memories columns the migration cares about (seeded minimal).
  columns: string[] = ['id', 'workspace_id', 'name', 'body', 'frontmatter_json'];
  execed: string[] = [];

  exec(sql: string): void {
    const t = sql.trim().replace(/\s+/g, ' ');
    const add = t.match(/ALTER TABLE memories ADD COLUMN (\w+)/i);
    if (add) {
      // Mirror SQLite: ADD COLUMN of an existing name would throw. The migration
      // guards with hasColumn, so this path should never receive a dup.
      if (this.columns.includes(add[1])) throw new Error(`duplicate column: ${add[1]}`);
      this.columns.push(add[1]);
    }
    this.execed.push(t);
  }

  prepare(sql: string) {
    const t = sql.trim();
    if (/PRAGMA table_info\(memories\)/i.test(t)) {
      return { all: (): ColRow[] => this.columns.map((c) => ({ name: c })) };
    }
    throw new Error(`MockDb.prepare unhandled: ${t.slice(0, 60)}`);
  }
}

function run(mock: MockDb): void {
  up(mock as unknown as Database.Database);
}

describe('0030_memory_aliases', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0030_memory_aliases');
  });

  it('adds the aliases_json column to memories', () => {
    const mock = new MockDb();
    run(mock);
    expect(mock.columns).toContain('aliases_json');
    expect(mock.execed.some((s) => /ALTER TABLE memories ADD COLUMN aliases_json TEXT/i.test(s))).toBe(true);
  });

  it('is idempotent — a second run does not re-add (no throw)', () => {
    const mock = new MockDb();
    run(mock);
    const afterFirst = [...mock.columns];
    expect(() => run(mock)).not.toThrow();
    expect(mock.columns).toEqual(afterFirst);
    // Only one ALTER was emitted across both runs.
    const alters = mock.execed.filter((s) => /ALTER TABLE memories ADD COLUMN/i.test(s));
    expect(alters).toHaveLength(1);
  });

  it('does not issue its own BEGIN/COMMIT (H-7 — runner owns the txn)', () => {
    const mock = new MockDb();
    run(mock);
    for (const s of mock.execed) {
      expect(s).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i);
    }
  });
});
