// P2 Task 1 — tests for migration 0041_jorvis_identity.
//
// vitest runs on the Node ABI but the repo builds better-sqlite3 for Electron
// (`electron-builder install-app-deps`), so a live in-memory DB can't be opened
// here — like the 0031/0039/0040 tests, we drive the migration with a
// recording mock and assert on the DDL/prepared-statement calls it emits (the
// migration's actual contract).

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0041_jorvis_identity';

interface PreparedCall {
  sql: string;
  args: unknown[];
}

// Recording stand-in for the better-sqlite3 handle: captures both the DDL
// strings the migration runs via `db.exec` and the bound-parameter calls it
// makes via `db.prepare(...).run(...)` (the KV seed insert).
class RecordingDb {
  statements: string[] = [];
  prepared: PreparedCall[] = [];

  exec = (sql: string): void => {
    const t = sql.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return;
    this.statements.push(t.replace(/\s+/g, ' '));
  };

  prepare = (sql: string) => {
    const t = sql.trim().replace(/\s+/g, ' ');
    return {
      run: (...args: unknown[]) => {
        this.prepared.push({ sql: t, args });
      },
    };
  };
}

function runUp(): RecordingDb {
  const db = new RecordingDb();
  up(db as unknown as Database.Database);
  return db;
}

function emittedDdl(): string {
  return runUp().statements.join('\n');
}

describe('0041_jorvis_identity', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0041_jorvis_identity');
  });

  it('creates jorvis_memory with all columns', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS jorvis_memory');
    expect(ddl).toContain('kind TEXT NOT NULL');
    expect(ddl).toContain('title TEXT NOT NULL');
    expect(ddl).toContain('body TEXT NOT NULL');
    expect(ddl).toContain("tags TEXT NOT NULL DEFAULT '[]'");
    expect(ddl).toContain('workspace_id TEXT');
    expect(ddl).toContain('confidence REAL NOT NULL DEFAULT 0.7');
    expect(ddl).toContain('created_at INTEGER NOT NULL');
    expect(ddl).toContain('updated_at INTEGER NOT NULL');
    expect(ddl).toContain('last_used_at INTEGER');
  });

  it('creates an external-content FTS5 virtual table over jorvis_memory(title, body)', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS jorvis_memory_fts USING fts5(');
    expect(ddl).toMatch(/title,/);
    expect(ddl).toMatch(/body,/);
    expect(ddl).toContain("content='jorvis_memory'");
    expect(ddl).toContain("content_rowid='rowid'");
  });

  it('creates AFTER INSERT / DELETE / UPDATE sync triggers using the external-content delete command', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain(
      'CREATE TRIGGER IF NOT EXISTS jorvis_memory_fts_ai AFTER INSERT ON jorvis_memory',
    );
    expect(ddl).toContain(
      'CREATE TRIGGER IF NOT EXISTS jorvis_memory_fts_ad AFTER DELETE ON jorvis_memory',
    );
    expect(ddl).toContain(
      'CREATE TRIGGER IF NOT EXISTS jorvis_memory_fts_au AFTER UPDATE ON jorvis_memory',
    );
    // External-content tables must issue the special 'delete' command so FTS5
    // forgets the old indexed terms on delete/update.
    expect(ddl).toContain("VALUES ('delete', old.rowid, old.title, old.body)");
  });

  it('populates the index via the FTS5 rebuild command (one-time insert)', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain("INSERT INTO jorvis_memory_fts(jorvis_memory_fts) VALUES ('rebuild')");
  });

  it('creates jorvis_amendments with all columns', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS jorvis_amendments');
    expect(ddl).toContain('text TEXT NOT NULL');
    expect(ddl).toContain('rationale TEXT');
    expect(ddl).toContain("status TEXT NOT NULL DEFAULT 'proposed'");
    expect(ddl).toContain('decision_reason TEXT');
    expect(ddl).toContain('proposed_at INTEGER NOT NULL');
    expect(ddl).toContain('decided_at INTEGER');
  });

  it('creates the expected indexes on jorvis_memory (kind, workspace_id) and jorvis_amendments (status)', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS jorvis_memory_kind_idx ON jorvis_memory(kind)');
    expect(ddl).toContain(
      'CREATE INDEX IF NOT EXISTS jorvis_memory_ws_idx ON jorvis_memory(workspace_id)',
    );
    expect(ddl).toContain(
      'CREATE INDEX IF NOT EXISTS jorvis_amendments_status_idx ON jorvis_amendments(status)',
    );
  });

  it('seeds jorvis.charter.path as an empty-string KV default via INSERT OR IGNORE', () => {
    const db = runUp();
    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0].sql).toContain('INSERT OR IGNORE INTO kv');
    expect(db.prepared[0].args).toEqual(['jorvis.charter.path', '']);
  });

  it('does not issue its own BEGIN/COMMIT (H-7 — runner owns the txn)', () => {
    const db = runUp();
    for (const s of db.statements) {
      expect(s).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i);
    }
  });

  it('is idempotent — uses IF NOT EXISTS/OR IGNORE and re-runs without throwing', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS');
    expect(ddl).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS');
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    expect(() => up(db as unknown as Database.Database)).not.toThrow();
  });
});
