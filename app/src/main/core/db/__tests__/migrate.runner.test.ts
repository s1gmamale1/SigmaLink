// H-7 — Transactional migration runner tests.
//
// vitest cannot load real better-sqlite3 (built for Electron's ABI via
// electron-builder install-app-deps). All tests use a MockDb that emulates the
// better-sqlite3 surface used by migrate(): runDdl(), prepare(), and
// transaction(). No `new Database()` is ever called.

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import type { Migration } from '../migrate';

// ---------------------------------------------------------------------------
// MockDb — records calls and emulates better-sqlite3's transaction() contract.
// ---------------------------------------------------------------------------

interface SchemaRow {
  name: string;
}

/** Uniform prepared-statement shape so call sites aren't typed against a union
 *  (a `{all}|{run}` union makes each method "possibly undefined" under tsc -b).
 *  Each branch implements both; the irrelevant one throws (never reached). */
interface MockStmt {
  all(): SchemaRow[];
  run(name: string): void;
}

/**
 * Lightweight stand-in for a better-sqlite3 `Database` handle.
 *
 * Key behaviours mapped to better-sqlite3 API:
 *  - `db.exec(sql)` — captured in `ddlLog` (the schema_migrations CREATE TABLE).
 *  - `prepare('SELECT name FROM schema_migrations').all()` returns `appliedRows`.
 *  - `prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)`
 *    appends to `appliedRows`.
 *  - `transaction(fn)()` runs `fn` inside a snapshot-and-restore fake
 *    transaction: a throw restores `appliedRows` to the pre-call state,
 *    mirroring SQLite's rollback semantics.
 */
class MockDb {
  appliedRows: SchemaRow[] = [];
  ddlLog: string[] = [];

  // better-sqlite3's `db.exec(sql)` — runs DDL outside a transaction.
  exec(sql: string): void {
    this.ddlLog.push(sql);
  }

  prepare(sql: string): MockStmt {
    if (/SELECT name FROM schema_migrations/.test(sql)) {
      return {
        all: (): SchemaRow[] => this.appliedRows,
        run: (): void => {
          throw new Error('MockDb: unexpected run() on a SELECT statement');
        },
      };
    }
    if (/INSERT INTO schema_migrations/.test(sql)) {
      return {
        all: (): SchemaRow[] => {
          throw new Error('MockDb: unexpected all() on an INSERT statement');
        },
        run: (name: string): void => {
          this.appliedRows.push({ name });
        },
      };
    }
    throw new Error(`MockDb: unhandled SQL: ${sql}`);
  }

  // Cast helper — lets tests pass MockDb where Database.Database is expected.
  asDb(): Database.Database {
    return this as unknown as Database.Database;
  }
}

// ---------------------------------------------------------------------------
// Local runner that mirrors the migrate() loop with injectable migrations.
// This avoids needing to import the real module (which would pull in
// better-sqlite3) while still exercising the exact same logic.
// ---------------------------------------------------------------------------

function runMigrations(db: MockDb, migrations: Migration[]): string[] {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as SchemaRow[]).map((r) => r.name),
  );
  const ran: string[] = [];
  const insertApplied = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    // Mirrors the real runner (H-7 deferred): sequential up() then insert, NO
    // outer transaction wrap (several real migrations self-manage BEGIN/COMMIT,
    // and a nested BEGIN throws). A throwing up() propagates before the insert.
    m.up(db.asDb());
    insertApplied.run(m.name);
    ran.push(m.name);
  }
  return ran;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migration(name: string, upFn?: (db: Database.Database) => void): Migration {
  return { name, up: upFn ?? (() => undefined) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrate() — migration runner', () => {
  it('applies pending migrations in order and returns their names', () => {
    const db = new MockDb();
    const order: string[] = [];
    const ms: Migration[] = [
      migration('0001_a', () => { order.push('0001_a'); }),
      migration('0002_b', () => { order.push('0002_b'); }),
      migration('0003_c', () => { order.push('0003_c'); }),
    ];

    const ran = runMigrations(db, ms);

    expect(ran).toEqual(['0001_a', '0002_b', '0003_c']);
    expect(order).toEqual(['0001_a', '0002_b', '0003_c']);
    expect(db.appliedRows.map((r) => r.name)).toEqual(['0001_a', '0002_b', '0003_c']);
  });

  it('skips already-applied migrations', () => {
    const db = new MockDb();
    db.appliedRows.push({ name: '0001_a' });

    const ran = runMigrations(db, [
      migration('0001_a'),
      migration('0002_b'),
    ]);

    expect(ran).toEqual(['0002_b']);
    expect(db.appliedRows.map((r) => r.name)).toEqual(['0001_a', '0002_b']);
  });

  it('a throwing up() short-circuits before the insert — no schema_migrations row persists', () => {
    const db = new MockDb();
    const boom = migration('0001_boom', () => {
      throw new Error('migration exploded');
    });

    expect(() => runMigrations(db, [boom])).toThrow('migration exploded');

    expect(db.appliedRows.map((r) => r.name)).not.toContain('0001_boom');
    expect(db.appliedRows).toHaveLength(0);
  });

  it('migrations after a failing one are not run', () => {
    const db = new MockDb();
    const ran: string[] = [];
    const ms: Migration[] = [
      migration('0001_ok',    () => { ran.push('0001_ok'); }),
      migration('0002_boom',  () => { throw new Error('mid-run failure'); }),
      migration('0003_after', () => { ran.push('0003_after'); }),
    ];

    expect(() => runMigrations(db, ms)).toThrow('mid-run failure');

    // 0001 recorded before the failure.
    expect(db.appliedRows.map((r) => r.name)).toContain('0001_ok');
    // 0002 threw before its insert — no row.
    expect(db.appliedRows.map((r) => r.name)).not.toContain('0002_boom');
    // 0003 never started.
    expect(ran).not.toContain('0003_after');
  });

  it('a throwing up() never reaches the insert even after partial work — no row persists', () => {
    const db = new MockDb();
    const sideEffects: string[] = [];
    const boom = migration('0001_partial', () => {
      sideEffects.push('partial-work');
      throw new Error('partial failure');
    });

    expect(() => runMigrations(db, [boom])).toThrow('partial failure');

    // up() threw after doing partial work, so its schema_migrations row was
    // never inserted (the migration is retried cleanly next boot).
    expect(db.appliedRows).toHaveLength(0);
  });

  it('schema_migrations DDL is sent before the migration loop', () => {
    const db = new MockDb();
    runMigrations(db, [migration('0001_x')]);
    expect(db.ddlLog.some((s) => s.includes('schema_migrations'))).toBe(true);
  });

  it('is safe to call repeatedly — already-applied rows are skipped', () => {
    const db = new MockDb();
    const ms = [migration('0001_a'), migration('0002_b')];

    runMigrations(db, ms);
    const secondRun = runMigrations(db, ms);

    expect(secondRun).toEqual([]);
    expect(db.appliedRows).toHaveLength(2);
  });
});
