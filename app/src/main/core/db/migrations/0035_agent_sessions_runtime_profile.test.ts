// RAM Brake — tests for migration 0035_agent_sessions_runtime_profile.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0035_agent_sessions_runtime_profile';

class RecordingDb {
  statements: string[] = [];
  exec = (sql: string): void => {
    this.statements.push(sql.trim().replace(/\s+/g, ' '));
  };
}

function emittedDdl(): string {
  const db = new RecordingDb();
  up(db as unknown as Database.Database);
  return db.statements.join('\n');
}

describe('0035_agent_sessions_runtime_profile', () => {
  it('migration name constant matches the file name', () => {
    expect(name).toBe('0035_agent_sessions_runtime_profile');
  });

  it('adds runtime_profile_id with ruflo-core as the legacy-row default', () => {
    const ddl = emittedDdl();
    expect(ddl).toContain(
      "ALTER TABLE agent_sessions ADD COLUMN runtime_profile_id TEXT NOT NULL DEFAULT 'ruflo-core'",
    );
  });
});
