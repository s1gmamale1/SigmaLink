// SF-10 — tests for migration 0025_agent_sessions_display_provider.
//
// vitest runs on the Node ABI but the repo builds better-sqlite3 for Electron,
// so no live DB. We drive the migration with a recording mock and assert on the
// DDL it emits. This migration runs its DDL via `db.prepare(sql).run()` (single
// ALTER statement) rather than `db.exec`, so the mock records prepared SQL.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0025_agent_sessions_display_provider';

class RecordingDb {
  statements: string[] = [];
  prepare = (sql: string) => {
    this.statements.push(sql.trim().replace(/\s+/g, ' '));
    return { run: (): void => {} };
  };
}

function emittedDdl(): string {
  const db = new RecordingDb();
  up(db as unknown as Database.Database);
  return db.statements.join('\n');
}

describe('0025_agent_sessions_display_provider', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0025_agent_sessions_display_provider');
  });

  it('emits ALTER TABLE agent_sessions ADD COLUMN display_provider_id TEXT', () => {
    expect(emittedDdl()).toContain(
      'ALTER TABLE agent_sessions ADD COLUMN display_provider_id TEXT',
    );
  });

  it('adds a NULLABLE column (no NOT NULL — existing rows keep showing the real provider)', () => {
    expect(emittedDdl()).not.toContain('NOT NULL');
  });

  it('re-runs without throwing', () => {
    const db = new RecordingDb();
    up(db as unknown as Database.Database);
    expect(() => up(db as unknown as Database.Database)).not.toThrow();
  });
});
