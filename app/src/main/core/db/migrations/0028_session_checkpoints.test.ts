// P6 FEAT-11 — tests for migration 0028_session_checkpoints.
//
// vitest runs on the Node ABI but the repo builds better-sqlite3 for Electron
// (`electron-builder install-app-deps`), so a live in-memory DB can't be opened
// here — like the 0023 test, we drive the migration with a recording mock and
// assert on the DDL it emits (the migration's actual contract).

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0028_session_checkpoints';

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

describe('0028_session_checkpoints', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0028_session_checkpoints');
  });

  it('creates session_checkpoints with the expected columns', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS session_checkpoints');
    expect(ddl).toContain('id TEXT NOT NULL PRIMARY KEY');
    expect(ddl).toContain('session_id TEXT NOT NULL');
    expect(ddl).toContain('sha TEXT NOT NULL');
    expect(ddl).toContain('label TEXT');
    expect(ddl).toContain('kind TEXT NOT NULL');
    expect(ddl).toContain('created_at INTEGER NOT NULL');
  });

  it('creates the session_id index', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS session_checkpoints_session_idx');
    expect(ddl).toContain('ON session_checkpoints(session_id)');
  });

  it('does not issue its own BEGIN/COMMIT (H-7 — runner owns the txn)', () => {
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    for (const s of db.statements) {
      expect(s).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i);
    }
  });

  it('is idempotent — uses IF NOT EXISTS and re-runs without throwing', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS');
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    expect(() => up(db as unknown as Database.Database)).not.toThrow();
  });
});
