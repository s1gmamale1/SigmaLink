// CRIT [db] 2026-06-10 audit — BOOTSTRAP_SQL re-created the UNIQUE
// workspaces_root_idx on EVERY boot after migration 0034 dropped it once.
// bootstrapAndMigrate() execs BOOTSTRAP_SQL before migrate(); 0034 is
// recorded in schema_migrations and never re-runs, so from boot 2 onward the
// unique index is back: workspaces.openNew (DEV-W3a duplicate root_path by
// design) throws UNIQUE constraint, and if duplicate rows ALREADY exist the
// CREATE UNIQUE INDEX itself throws -> initializeDatabase throws ->
// registerRouter rejects -> the app fails to boot.
//
// better-sqlite3 cannot load under vitest (Electron ABI) and client.ts
// imports it at module top — so, following the migrate.spec.ts precedent,
// this suite parses BOOTSTRAP_SQL out of client.ts SOURCE TEXT and replays
// the boot sequence (bootstrap -> 0034 -> bootstrap -> ...) against a fake
// index engine that models exactly the SQLite behaviours at stake:
//   - CREATE [UNIQUE] INDEX IF NOT EXISTS <name> ON workspaces(root_path)
//   - DROP INDEX IF EXISTS <name>
//   - CREATE UNIQUE INDEX over duplicate root_path rows THROWS
// No `new Database()` is ever called.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { up as up0034 } from './migrations/0034_drop_workspaces_root_idx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = fs.readFileSync(path.join(__dirname, 'client.ts'), 'utf8');

function bootstrapSql(): string {
  const m = clientSrc.match(/const BOOTSTRAP_SQL = `([\s\S]*?)`;/);
  if (!m) throw new Error('BOOTSTRAP_SQL template literal not found in client.ts');
  return m[1];
}

interface IndexState {
  unique: boolean;
}

/**
 * Models ONLY the workspaces(root_path) index DDL out of any SQL batch.
 * Every other statement (CREATE TABLE, indexes on other tables, `--`
 * comments) is ignored — faithful enough to reproduce the boot-order bug.
 */
class FakeIndexEngine {
  indexes = new Map<string, IndexState>();
  /** Simulates duplicate root_path rows in workspaces (legal since DEV-W3a:
   *  openWorkspaceNew inserts duplicates by design). */
  hasDuplicateRootPaths = false;

  exec(sql: string): void {
    for (const raw of sql.split(';')) {
      const stmt = raw
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ');
      if (!stmt) continue;

      const create =
        /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON workspaces\s*\(\s*root_path\s*\)$/i.exec(
          stmt,
        );
      if (create) {
        const unique = Boolean(create[1]);
        const name = create[2];
        if (this.indexes.has(name)) continue; // IF NOT EXISTS
        if (unique && this.hasDuplicateRootPaths) {
          // Real SQLite: building a UNIQUE index over duplicate values throws.
          // In production that aborts sqlite.exec(BOOTSTRAP_SQL) ->
          // initializeDatabase throws (client.ts, unwrapped) -> boot failure.
          throw new Error(
            `UNIQUE constraint failed: workspaces.root_path (creating ${name})`,
          );
        }
        this.indexes.set(name, { unique });
        continue;
      }

      const drop = /^DROP INDEX IF EXISTS (\w+)$/i.exec(stmt);
      if (drop) {
        this.indexes.delete(drop[1]);
        continue;
      }
      /* anything else: not modelled */
    }
  }

  /** Lets the engine stand in for better-sqlite3 where only exec() is used
   *  (0034's up() calls db.exec exactly twice). */
  asDb(): Database.Database {
    return this as unknown as Database.Database;
  }

  uniqueIndexNames(): string[] {
    return [...this.indexes.entries()]
      .filter(([, s]) => s.unique)
      .map(([name]) => name);
  }
}

describe('BOOTSTRAP_SQL x migration 0034 — workspaces(root_path) index convergence', () => {
  it('source: BOOTSTRAP_SQL no longer declares the UNIQUE workspaces_root_idx', () => {
    expect(bootstrapSql()).not.toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+workspaces_root_idx/i,
    );
  });

  it('source: BOOTSTRAP_SQL defensively drops the unique twin and creates the non-unique lookup index', () => {
    const sql = bootstrapSql();
    expect(sql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+workspaces_root_idx/i);
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+workspaces_root_lookup_idx\s+ON\s+workspaces\s*\(\s*root_path\s*\)/i,
    );
  });

  it('fresh install: boot 2 (bootstrap re-runs, 0034 already recorded) leaves NO unique index', () => {
    const eng = new FakeIndexEngine();
    // Boot 1 — bootstrapAndMigrate(): BOOTSTRAP_SQL, then pending 0034 runs once.
    eng.exec(bootstrapSql());
    up0034(eng.asDb());
    // Boot 2 — BOOTSTRAP_SQL re-runs; 0034 is recorded and never re-runs.
    eng.exec(bootstrapSql());

    expect(eng.uniqueIndexNames()).toEqual([]);
    expect(eng.indexes.has('workspaces_root_lookup_idx')).toBe(true);
    expect(eng.indexes.has('workspaces_root_idx')).toBe(false);
  });

  it('duplicate root_path rows already inserted (DEV-W3a): the next boot must not throw', () => {
    const eng = new FakeIndexEngine();
    eng.exec(bootstrapSql());
    up0034(eng.asDb());
    // Operator used workspaces.openNew — two rows now share a root_path.
    eng.hasDuplicateRootPaths = true;
    // Boot 2: with the old SQL this threw (CREATE UNIQUE INDEX over dupes)
    // and the app failed to boot.
    expect(() => eng.exec(bootstrapSql())).not.toThrow();
    expect(eng.uniqueIndexNames()).toEqual([]);
  });

  it('self-heal: an install where a past boot already re-created the unique twin converges', () => {
    const eng = new FakeIndexEngine();
    // State left behind by the buggy build: BOTH indexes exist.
    eng.indexes.set('workspaces_root_idx', { unique: true });
    eng.indexes.set('workspaces_root_lookup_idx', { unique: false });
    // Next boot with the fixed SQL (0034 recorded, only bootstrap runs).
    eng.exec(bootstrapSql());

    expect(eng.indexes.has('workspaces_root_idx')).toBe(false);
    expect(eng.indexes.has('workspaces_root_lookup_idx')).toBe(true);
    expect(eng.uniqueIndexNames()).toEqual([]);
  });

  it('pre-0034 upgrade converges to the same end-state as a fresh install', () => {
    // Upgrading install: legacy unique index live, 0034 still pending.
    const upgraded = new FakeIndexEngine();
    upgraded.indexes.set('workspaces_root_idx', { unique: true });
    upgraded.exec(bootstrapSql());
    up0034(upgraded.asDb()); // pending migration applies on this boot
    upgraded.exec(bootstrapSql()); // ...and the boot after

    // Fresh install, two boots.
    const fresh = new FakeIndexEngine();
    fresh.exec(bootstrapSql());
    up0034(fresh.asDb());
    fresh.exec(bootstrapSql());

    expect([...upgraded.indexes.entries()].sort()).toEqual(
      [...fresh.indexes.entries()].sort(),
    );
    expect(upgraded.uniqueIndexNames()).toEqual([]);
  });
});
