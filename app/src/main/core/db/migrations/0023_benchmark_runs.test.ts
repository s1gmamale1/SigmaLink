// C-12 SigmaBench — tests for migration 0023_benchmark_runs.
//
// Unlike the MockDb-driven 0021 test, this migration owns two tables with
// real columns the store/harness depend on, so we exercise it against an
// in-memory better-sqlite3 instance and assert the actual schema + that the
// migration is idempotent (CREATE TABLE IF NOT EXISTS).

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { name, up } from './0023_benchmark_runs';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table) !== undefined
  );
}

describe('0023_benchmark_runs', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0023_benchmark_runs');
  });

  it('creates benchmark_runs with the expected columns', () => {
    const db = new Database(':memory:');
    up(db);
    expect(tableExists(db, 'benchmark_runs')).toBe(true);

    const cols = columns(db, 'benchmark_runs');
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(
      ['category', 'created_at', 'id', 'status', 'task_prompt'].sort(),
    );
    expect(byName.get('id')?.pk).toBe(1);
    expect(byName.get('created_at')?.notnull).toBe(1);
    expect(byName.get('category')?.notnull).toBe(1);
    expect(byName.get('task_prompt')?.notnull).toBe(1);
    expect(byName.get('status')?.notnull).toBe(1);
    db.close();
  });

  it('creates benchmark_results with the expected columns + composite PK', () => {
    const db = new Database(':memory:');
    up(db);
    expect(tableExists(db, 'benchmark_results')).toBe(true);

    const cols = columns(db, 'benchmark_results');
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'changed_files',
        'conflict_score',
        'exit_code',
        'provider',
        'run_id',
        'session_id',
      ].sort(),
    );
    // Composite primary key on (run_id, session_id).
    expect(byName.get('run_id')?.pk).toBeGreaterThan(0);
    expect(byName.get('session_id')?.pk).toBeGreaterThan(0);
    expect(byName.get('provider')?.notnull).toBe(1);
    expect(byName.get('changed_files')?.notnull).toBe(1);
    db.close();
  });

  it('is idempotent — running up twice on the same DB does not throw', () => {
    const db = new Database(':memory:');
    up(db);
    expect(() => up(db)).not.toThrow();
    expect(tableExists(db, 'benchmark_runs')).toBe(true);
    expect(tableExists(db, 'benchmark_results')).toBe(true);
    db.close();
  });

  it('accepts a representative insert into both tables', () => {
    const db = new Database(':memory:');
    up(db);
    db.prepare(
      `INSERT INTO benchmark_runs (id, created_at, category, task_prompt, status)
       VALUES (?,?,?,?,?)`,
    ).run('run-1', Date.now(), 'multi-agent-conflict', 'do the thing', 'running');
    db.prepare(
      `INSERT INTO benchmark_results
         (run_id, session_id, provider, changed_files, conflict_score, exit_code)
       VALUES (?,?,?,?,?,?)`,
    ).run('run-1', 'sess-1', 'claude', JSON.stringify(['src/a.ts']), 0, 0);

    const row = db
      .prepare('SELECT changed_files FROM benchmark_results WHERE run_id=?')
      .get('run-1') as { changed_files: string };
    expect(JSON.parse(row.changed_files)).toEqual(['src/a.ts']);
    db.close();
  });
});
