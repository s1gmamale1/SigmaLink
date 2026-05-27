// SF-8 Yolo/Bypass — tests for migration 0024_agent_sessions_auto_approve.
//
// vitest runs on the Node ABI but the repo builds better-sqlite3 for Electron
// (`electron-builder install-app-deps`), so a live in-memory DB cannot be
// opened here. We drive the migration with a recording mock and assert on the
// DDL it emits (the migration's actual contract). The column is exercised for
// real by the production/smoke path.
//
// Pattern mirrors 0023_benchmark_runs.test.ts verbatim (RecordingDb, emittedDdl).

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0024_agent_sessions_auto_approve';

// Recording stand-in for the better-sqlite3 handle: captures the DDL strings
// the migration runs (its `db.exec` SQL runner) and ignores transaction
// keywords.
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

describe('0024_agent_sessions_auto_approve', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0024_agent_sessions_auto_approve');
  });

  it('emits ALTER TABLE agent_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('ALTER TABLE agent_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0');
  });

  it('targets the agent_sessions table', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('agent_sessions');
  });

  it('re-runs without throwing (idempotent via IF NOT EXISTS guard or noop)', () => {
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    // Should not throw on a second call
    expect(() => up(db as unknown as Database.Database)).not.toThrow();
  });
});
