// Test for migration 0027_memories_name_nocase (BUG-12).
//
// Uses a MockDb that tracks `memories` rows in-memory plus an index set — the
// same MockDb philosophy as 0020's test (better-sqlite3 cannot load under
// vitest, so we NEVER `new Database()`). The mock interprets the exact SQL the
// migration emits:
//   - the collision-detection SELECT (group-by lower(name) HAVING COUNT>1),
//     returned ordered keeper-first;
//   - the rename UPDATE (by id);
//   - DROP INDEX / CREATE UNIQUE INDEX ... COLLATE NOCASE DDL.
//
// Verifies:
//   1. The unique index is recreated WITH `COLLATE NOCASE`.
//   2. Case-variant duplicates are renamed — the most-recently-updated row in
//      each (workspace, lower(name)) group is kept, the others get a
//      "(dup <id-prefix>)" suffix.
//   3. Non-colliding rows and distinct workspaces are left untouched.
//   4. Idempotency — a second run finds no collisions and leaves rows intact.

import { describe, expect, it } from 'vitest';
import { up } from './0027_memories_name_nocase';

interface MemRow {
  id: string;
  workspace_id: string;
  name: string;
  updated_at: number;
}

class MockDb {
  rows: MemRow[] = [];
  indexes = new Map<string, string>(); // name -> full DDL (so we can assert COLLATE)

  exec(sql: string): void {
    const trimmed = sql.trim();
    const drop = trimmed.match(/DROP INDEX IF EXISTS\s+(\w+)/i);
    if (drop) {
      this.indexes.delete(drop[1]);
      return;
    }
    const create = trimmed.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/i);
    if (create) {
      this.indexes.set(create[1], trimmed);
      return;
    }
    throw new Error(`MockDb.exec unhandled: ${trimmed.slice(0, 60)}`);
  }

  prepare(sql: string) {
    const trimmed = sql.trim();
    // Collision-detection SELECT.
    if (/SELECT id, workspace_id, name, updated_at/i.test(trimmed)) {
      return {
        all: (): MemRow[] => {
          // Group by (workspace_id, lower(name)); only groups with >1 row.
          const groups = new Map<string, MemRow[]>();
          for (const r of this.rows) {
            const key = `${r.workspace_id}::${r.name.toLowerCase()}`;
            const g = groups.get(key) ?? [];
            g.push(r);
            groups.set(key, g);
          }
          const out: MemRow[] = [];
          // Emit groups ordered, each sorted updated_at DESC, id DESC (keeper first).
          const keys = [...groups.keys()].sort();
          for (const key of keys) {
            const g = groups.get(key)!;
            if (g.length <= 1) continue;
            g.sort((a, b) =>
              b.updated_at !== a.updated_at
                ? b.updated_at - a.updated_at
                : b.id > a.id
                  ? 1
                  : -1,
            );
            out.push(...g);
          }
          return out;
        },
      };
    }
    // Rename UPDATE by id.
    if (/UPDATE memories SET name = \?.*WHERE id = \?/is.test(trimmed)) {
      return {
        run: (newName: string, id: string): void => {
          const row = this.rows.find((r) => r.id === id);
          if (row) row.name = newName;
        },
      };
    }
    throw new Error(`MockDb.prepare unhandled: ${trimmed.slice(0, 60)}`);
  }
}

function run(mock: MockDb): void {
  up(mock as unknown as Parameters<typeof up>[0]);
}

describe('0027_memories_name_nocase', () => {
  it('recreates the unique index with COLLATE NOCASE', () => {
    const mock = new MockDb();
    run(mock);
    const ddl = mock.indexes.get('memories_ws_name_uq');
    expect(ddl).toBeDefined();
    expect(ddl).toMatch(/COLLATE NOCASE/i);
    expect(ddl).toMatch(/UNIQUE/i);
    // The inbound-link index is also rebuilt NOCASE.
    expect(mock.indexes.get('memory_links_to_idx')).toMatch(/COLLATE NOCASE/i);
  });

  it('renames case-variant duplicates, keeping the newest updated_at', () => {
    const mock = new MockDb();
    mock.rows = [
      { id: 'aaaa1111', workspace_id: 'ws1', name: 'Foo', updated_at: 100 }, // older
      { id: 'bbbb2222', workspace_id: 'ws1', name: 'foo', updated_at: 200 }, // newest -> keeper
    ];
    run(mock);
    const keeper = mock.rows.find((r) => r.id === 'bbbb2222');
    const loser = mock.rows.find((r) => r.id === 'aaaa1111');
    expect(keeper!.name).toBe('foo'); // unchanged
    expect(loser!.name).toBe('Foo (dup aaaa1111)');
  });

  it('leaves non-colliding rows and distinct workspaces untouched', () => {
    const mock = new MockDb();
    mock.rows = [
      { id: 'x1', workspace_id: 'ws1', name: 'Alpha', updated_at: 1 },
      { id: 'x2', workspace_id: 'ws1', name: 'Beta', updated_at: 1 },
      { id: 'x3', workspace_id: 'ws2', name: 'alpha', updated_at: 1 }, // same name, other ws — fine
    ];
    run(mock);
    expect(mock.rows.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta', 'alpha']);
  });

  it('handles a 3-way collision — keeps newest, renames the other two', () => {
    const mock = new MockDb();
    mock.rows = [
      { id: 'id-a', workspace_id: 'ws1', name: 'Note', updated_at: 10 },
      { id: 'id-b', workspace_id: 'ws1', name: 'note', updated_at: 30 }, // newest
      { id: 'id-c', workspace_id: 'ws1', name: 'NOTE', updated_at: 20 },
    ];
    run(mock);
    const byId = (id: string) => mock.rows.find((r) => r.id === id)!.name;
    expect(byId('id-b')).toBe('note'); // keeper untouched
    expect(byId('id-a')).toBe('Note (dup id-a)');
    expect(byId('id-c')).toBe('NOTE (dup id-c)');
    // All three names are now NOCASE-distinct.
    const lowered = mock.rows.map((r) => r.name.toLowerCase());
    expect(new Set(lowered).size).toBe(3);
  });

  it('is idempotent — a second run is a no-op on rows', () => {
    const mock = new MockDb();
    mock.rows = [
      { id: 'k1', workspace_id: 'ws1', name: 'Foo', updated_at: 100 },
      { id: 'k2', workspace_id: 'ws1', name: 'foo', updated_at: 200 },
    ];
    run(mock);
    const afterFirst = mock.rows.map((r) => r.name).sort();
    run(mock);
    const afterSecond = mock.rows.map((r) => r.name).sort();
    expect(afterSecond).toEqual(afterFirst);
  });

  it('no rows — still builds the NOCASE index', () => {
    const mock = new MockDb();
    run(mock);
    expect(mock.indexes.get('memories_ws_name_uq')).toMatch(/COLLATE NOCASE/i);
  });
});
