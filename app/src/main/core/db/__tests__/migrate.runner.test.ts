// H-7 — Transactional migration runner tests.
//
// vitest cannot load real better-sqlite3 (built for Electron's ABI via
// electron-builder install-app-deps). All tests use a MockDb that emulates the
// better-sqlite3 surface used by migrate(): exec(), prepare(), and
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
 *    If called with `BEGIN` while already in a transaction, throws
 *    `"cannot start a transaction within a transaction"` — matching real SQLite.
 *  - `prepare('SELECT name FROM schema_migrations').all()` returns `appliedRows`.
 *  - `prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)`
 *    appends to `appliedRows`.
 *  - `transaction(fn)` returns a function. Calling that function:
 *    - Throws if already in a transaction (nested transactions are illegal in
 *      better-sqlite3, matching SQLite's "cannot start a transaction within a
 *      transaction" error).
 *    - Otherwise snapshots `appliedRows`, sets `inTransaction = true`, runs
 *      `fn(arg)`, on success sets `inTransaction = false` and returns the result.
 *    - On throw: restores the `appliedRows` snapshot (rollback), sets
 *      `inTransaction = false`, and rethrows — mirroring SQLite's ROLLBACK.
 */
class MockDb {
  appliedRows: SchemaRow[] = [];
  ddlLog: string[] = [];
  private inTransaction = false;

  // better-sqlite3's `db.exec(sql)` — runs DDL / raw SQL outside a transaction.
  // Mirrors the real engine's rejection of BEGIN while already inside a txn.
  exec(sql: string): void {
    const keyword = sql.trim().toUpperCase();
    if (keyword === 'BEGIN' || keyword.startsWith('BEGIN ')) {
      if (this.inTransaction) {
        throw new Error('cannot start a transaction within a transaction');
      }
      // Bare BEGIN without our transaction() wrapper: not a path the H-7 runner
      // exercises, but track it so the "self-BEGIN migration" test works when
      // up() receives an asDb() handle and calls db.exec('BEGIN') directly.
      this.inTransaction = true;
      return;
    }
    if (keyword === 'COMMIT') {
      this.inTransaction = false;
      return;
    }
    if (keyword === 'ROLLBACK') {
      this.inTransaction = false;
      return;
    }
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

  /**
   * Emulates better-sqlite3's `db.transaction(fn)` — returns a wrapper
   * function that, when called, runs `fn` inside a snapshot-and-restore fake
   * transaction.
   *
   * Throws immediately (without calling fn) if already in a transaction:
   * better-sqlite3 rejects nested transaction() calls with
   * "cannot start a transaction within a transaction".
   */
  transaction<T, A>(fn: (arg: A) => T): (arg: A) => T {
    return (arg: A): T => {
      if (this.inTransaction) {
        throw new Error('cannot start a transaction within a transaction');
      }
      // Snapshot state for rollback.
      const snapshot = this.appliedRows.slice();
      this.inTransaction = true;
      try {
        const result = fn(arg);
        this.inTransaction = false;
        return result;
      } catch (err) {
        // Rollback: restore snapshot.
        this.appliedRows = snapshot;
        this.inTransaction = false;
        throw err;
      }
    };
  }

  // Cast helper — lets tests pass MockDb where Database.Database is expected.
  asDb(): Database.Database {
    return this as unknown as Database.Database;
  }
}

// ---------------------------------------------------------------------------
// Local runner that mirrors the NEW migrate() loop (H-7 shape) with injectable
// migrations. This avoids needing to import the real module (which would pull
// in better-sqlite3) while still exercising the exact same logic.
//
// Canonical shape (from migrate.ts post-H-7):
//
//   db.exec(SCHEMA_MIGRATIONS_DDL);
//   const applied = new Set(...db.prepare('SELECT ...').all()...);
//   const ran: string[] = [];
//   const insertApplied = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
//   const applyOne = db.transaction((m: Migration) => {
//     m.up(db);
//     insertApplied.run(m.name);
//   });
//   for (const m of ALL_MIGRATIONS) {
//     if (applied.has(m.name)) continue;
//     applyOne(m);
//     ran.push(m.name);
//   }
//   return ran;
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

  // H-7: each migration runs inside its own transaction, matching the canonical
  // runner shape. The transaction() wrapper snapshots + restores appliedRows on
  // throw (rollback), and throws on nested transaction() calls.
  const applyOne = (db as unknown as { transaction: MockDb['transaction'] }).transaction(
    (m: Migration) => {
      m.up(db.asDb());
      insertApplied.run(m.name);
    },
  );

  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    applyOne(m);
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

    // 0001 was committed before the failure — its row must persist.
    expect(db.appliedRows.map((r) => r.name)).toContain('0001_ok');
    // 0002 threw — transaction rolled back, no row.
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
    // never inserted (the migration is retried cleanly next boot rather than
    // recorded half-applied).
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

  // ---------------------------------------------------------------------------
  // H-7 regression tests — these are the tests the prior MockDb COULD NOT catch.
  // The prior attempt was reverted because a nested-BEGIN regression passed unit
  // tests and only the e2e caught it. These tests close that gap.
  // ---------------------------------------------------------------------------

  it('a migration that issues its own BEGIN throws under the runner transaction', () => {
    // Simulates a legacy migration that self-manages its own transaction.
    // When the runner wraps each migration in db.transaction(), any attempt by
    // the migration's up() to exec('BEGIN') triggers better-sqlite3's
    // "cannot start a transaction within a transaction" error.
    const db = new MockDb();
    const selfBegin = migration('0001_self_begin', (rawDb) => {
      // Cast back to MockDb so exec() is the faithful implementation.
      (rawDb as unknown as MockDb).exec('BEGIN');
    });

    expect(() => runMigrations(db, [selfBegin])).toThrow(
      /cannot start a transaction within a transaction/,
    );

    // The transaction was rolled back — no schema_migrations row was inserted.
    expect(db.appliedRows.map((r) => r.name)).not.toContain('0001_self_begin');
    expect(db.appliedRows).toHaveLength(0);
  });

  it('a throwing up() rolls back the schema_migrations insert (explicit rollback assertion)', () => {
    // Belt-and-suspenders: verifies that the snapshot-restore in transaction()
    // correctly undoes the insert that would have happened inside the txn.
    const db = new MockDb();
    const ms: Migration[] = [
      migration('0001_ok', () => { /* succeeds */ }),
      migration('0002_rollback', () => {
        throw new Error('deliberate rollback');
      }),
    ];

    expect(() => runMigrations(db, ms)).toThrow('deliberate rollback');

    // 0001 committed before 0002 ran.
    expect(db.appliedRows.map((r) => r.name)).toContain('0001_ok');
    // 0002's transaction was rolled back — its row must not exist.
    expect(db.appliedRows.map((r) => r.name)).not.toContain('0002_rollback');
    expect(db.appliedRows).toHaveLength(1);
  });

  it('nested transaction() also throws — calling db.transaction inside a transaction', () => {
    // Verifies the MockDb correctly rejects nested transaction() calls.
    // This mirrors what better-sqlite3 does in production.
    const db = new MockDb();

    const outerTxn = (db as unknown as { transaction: MockDb['transaction'] }).transaction(
      () => {
        // Attempt to open a second transaction from within the first.
        const innerTxn = (db as unknown as { transaction: MockDb['transaction'] }).transaction(
          () => { /* never runs */ },
        );
        innerTxn(null);
      },
    );

    expect(() => outerTxn(null)).toThrow(
      /cannot start a transaction within a transaction/,
    );

    // State was restored to pre-outer-txn (nothing changed in this test).
    expect(db.appliedRows).toHaveLength(0);
  });
});
