// RAM Brake — tests for migration 0035_agent_sessions_runtime_profile.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0035_agent_sessions_runtime_profile';

class RecordingDb {
  columns = new Set<string>();
  statements: string[] = [];

  constructor(columns: string[] = []) {
    for (const column of columns) this.columns.add(column);
  }

  prepare = (sql: string) => {
    if (/PRAGMA table_info\(agent_sessions\)/i.test(sql)) {
      return {
        all: () => [...this.columns].map((column) => ({ name: column })),
      };
    }
    return { all: () => [] };
  };

  exec = (sql: string): void => {
    this.statements.push(sql.trim().replace(/\s+/g, ' '));
    const addColumn = sql.match(/ADD COLUMN\s+([a-z_]+)/i);
    if (addColumn) this.columns.add(addColumn[1]);
  };
}

function emittedDdl(columns: string[] = []): string {
  const db = new RecordingDb(columns);
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

  it('is idempotent when the fresh bootstrap schema already has the column', () => {
    expect(emittedDdl(['id', 'runtime_profile_id'])).toBe('');
  });
});
