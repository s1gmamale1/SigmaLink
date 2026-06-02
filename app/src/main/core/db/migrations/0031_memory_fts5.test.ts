// P4.2 PERF-14 — tests for migration 0031_memory_fts5.
//
// better-sqlite3 cannot load under vitest (built for Electron's ABI), so we
// drive the migration with a recording mock and assert on the DDL it emits
// (the migration's actual contract) — same approach as 0028/0029's tests.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up, down } from './0031_memory_fts5';

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

describe('0031_memory_fts5', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0031_memory_fts5');
  });

  it('creates an external-content FTS5 virtual table over memories(name, body)', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(');
    expect(ddl).toMatch(/name,/);
    expect(ddl).toMatch(/body,/);
    expect(ddl).toContain("content='memories'");
    expect(ddl).toContain("content_rowid='rowid'");
  });

  it('creates AFTER INSERT / DELETE / UPDATE sync triggers', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories');
    expect(ddl).toContain('CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories');
    expect(ddl).toContain('CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories');
  });

  it("uses the external-content 'delete' command on delete + update triggers", () => {
    const ddl = emittedDdl();
    // The delete trigger and the old half of the update trigger must emit the
    // special VALUES('delete', ...) command so FTS5 forgets the old terms.
    expect(ddl).toContain("VALUES ('delete', old.rowid, old.name, old.body)");
  });

  it('populates the index via the FTS5 rebuild command', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
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
    expect(ddl).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS');
    expect(ddl).toContain('CREATE TRIGGER IF NOT EXISTS');
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    expect(() => up(db as unknown as Database.Database)).not.toThrow();
  });

  it('down drops the triggers and the virtual table', () => {
    const db = new RecordingDb();
    down(db as unknown as Database.Database);
    const ddl = db.statements.join('\n');
    expect(ddl).toContain('DROP TRIGGER IF EXISTS memories_fts_au');
    expect(ddl).toContain('DROP TRIGGER IF EXISTS memories_fts_ad');
    expect(ddl).toContain('DROP TRIGGER IF EXISTS memories_fts_ai');
    expect(ddl).toContain('DROP TABLE IF EXISTS memories_fts');
  });
});
