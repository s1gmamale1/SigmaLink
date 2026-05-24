// C-12 SigmaBench — tests for migration 0023_benchmark_runs.
//
// vitest runs on the Node ABI but the repo builds better-sqlite3 for Electron
// (`electron-builder install-app-deps`), so a live in-memory DB can't be opened
// here — like the 0021 test, we drive the migration with a recording mock and
// assert on the DDL it emits (the migration's actual contract). The columns are
// exercised for real by the store test's fake DB + the production/smoke path.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0023_benchmark_runs';

// Recording stand-in for the better-sqlite3 handle: captures the DDL strings the
// migration runs (its `db.exec` SQL runner) and ignores transaction keywords.
class RecordingDb {
  statements: string[] = [];
  exec = (sql: string): void => {
    const t = sql.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return;
    this.statements.push(t.replace(/\s+/g, ' '));
  };
}

function emittedDdl(): string {
  const db = new RecordingDb();
  up(db as unknown as Database.Database);
  return db.statements.join('\n');
}

describe('0023_benchmark_runs', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0023_benchmark_runs');
  });

  it('creates benchmark_runs with the expected columns + constraints', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS benchmark_runs');
    expect(ddl).toContain('id TEXT NOT NULL PRIMARY KEY');
    expect(ddl).toContain('created_at INTEGER NOT NULL');
    expect(ddl).toContain('category TEXT NOT NULL');
    expect(ddl).toContain('task_prompt TEXT NOT NULL');
    expect(ddl).toContain('status TEXT NOT NULL');
  });

  it('creates benchmark_results with the expected columns + composite PK', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS benchmark_results');
    expect(ddl).toContain('provider TEXT NOT NULL');
    expect(ddl).toContain('changed_files TEXT NOT NULL');
    expect(ddl).toContain('PRIMARY KEY(run_id, session_id)');
  });

  it('is idempotent — uses CREATE TABLE IF NOT EXISTS and re-runs without throwing', () => {
    expect(emittedDdl()).toContain('CREATE TABLE IF NOT EXISTS');
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    expect(() => up(db as unknown as Database.Database)).not.toThrow();
  });
});
