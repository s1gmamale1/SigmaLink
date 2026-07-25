import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0043_notification_state_revision';

class NotificationStateMigrationDb {
  readonly ddl: string[] = [];
  revision: number | undefined;

  exec(sql: string): void {
    this.ddl.push(sql.replace(/\s+/g, ' ').trim());
  }

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT OR IGNORE INTO notification_state')) {
      return {
        run: (): { changes: number } => {
          if (this.revision !== undefined) return { changes: 0 };
          this.revision = 0;
          return { changes: 1 };
        },
      };
    }
    throw new Error(`Unhandled SQL: ${normalized}`);
  }
}

describe('0043_notification_state_revision', () => {
  it('uses the migration filename as its registration name', () => {
    expect(name).toBe('0043_notification_state_revision');
  });

  it('creates a checked singleton revision table and seeds revision zero', () => {
    const db = new NotificationStateMigrationDb();

    up(db as unknown as Database.Database);

    expect(db.ddl.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS notification_state',
    );
    expect(db.ddl.join('\n')).toContain(
      'singleton INTEGER PRIMARY KEY CHECK (singleton = 1)',
    );
    expect(db.ddl.join('\n')).toContain(
      'revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)',
    );
    expect(db.revision).toBe(0);
  });

  it('preserves an existing revision when rerun', () => {
    const db = new NotificationStateMigrationDb();
    db.revision = 41;

    up(db as unknown as Database.Database);

    expect(db.revision).toBe(41);
  });
});
