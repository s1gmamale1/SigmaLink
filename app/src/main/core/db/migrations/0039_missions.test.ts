// P1a Task 1 — tests for migration 0039_missions.
//
// vitest runs on the Node ABI but the repo builds better-sqlite3 for Electron
// (`electron-builder install-app-deps`), so a live in-memory DB can't be opened
// here — like the 0023 and 0028 tests, we drive the migration with a recording
// mock and assert on the DDL it emits (the migration's actual contract).

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0039_missions';

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

describe('0039_missions', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0039_missions');
  });

  it('creates the three mission tables with the expected columns', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS missions');
    expect(ddl).toContain("origin TEXT NOT NULL CHECK (origin IN ('local','telegram','external','autonomous'))");
    expect(ddl).toContain('workspace_id TEXT');
    expect(ddl).toContain("CHECK (status IN ('draft','active','paused','done','failed','cancelled'))");
    expect(ddl).toContain('report TEXT');

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS mission_tasks');
    expect(ddl).toContain('mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE');
    expect(ddl).toContain("spec TEXT NOT NULL DEFAULT ''");
    expect(ddl).toContain(
      "CHECK (status IN ('backlog','dispatched','working','reviewing','needs_input','done','blocked'))",
    );
    expect(ddl).toContain('assignee_session_id TEXT');
    expect(ddl).toContain('worktree_path TEXT');
    expect(ddl).toContain('attempt INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain('order_idx INTEGER NOT NULL DEFAULT 0');

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS mission_events');
    expect(ddl).toContain('task_id TEXT');
    expect(ddl).toContain('kind TEXT NOT NULL');
    expect(ddl).toContain('body TEXT');
    expect(ddl).toContain('ts INTEGER NOT NULL');
  });

  it('creates the expected indexes', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS mission_tasks_mission_status_idx');
    expect(ddl).toContain('ON mission_tasks (mission_id, status)');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS mission_tasks_assignee_idx');
    expect(ddl).toContain('ON mission_tasks (assignee_session_id)');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS mission_events_mission_ts_idx');
    expect(ddl).toContain('ON mission_events (mission_id, ts)');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS missions_status_idx');
    expect(ddl).toContain('ON missions (status)');
  });

  it('CASCADE deletes tasks + events when a mission is dropped (FK on both child tables)', () => {
    const ddl = emittedDdl();
    const mtStart = ddl.indexOf('CREATE TABLE IF NOT EXISTS mission_tasks');
    const meStart = ddl.indexOf('CREATE TABLE IF NOT EXISTS mission_events');
    expect(mtStart).toBeGreaterThanOrEqual(0);
    expect(meStart).toBeGreaterThan(mtStart);
    // Both child tables reference missions(id) ON DELETE CASCADE.
    const mtDdl = ddl.slice(mtStart, meStart);
    const meDdl = ddl.slice(meStart);
    expect(mtDdl).toContain('REFERENCES missions(id) ON DELETE CASCADE');
    expect(meDdl).toContain('REFERENCES missions(id) ON DELETE CASCADE');
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
