import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0038_os_notify_default_on';

interface KvRow {
  key: string;
  value: string;
  updated_at: number;
}

class MockDb {
  readonly rows = new Map<string, KvRow>();

  exec(_s: string): void {}

  prepare(sql: string) {
    if (/INSERT OR IGNORE INTO kv/i.test(sql)) {
      return {
        run: (..._a: unknown[]) => {
          const k = 'notifications.osEnabled';
          const v = '1';
          if (!this.rows.has(k)) {
            this.rows.set(k, { key: k, value: v, updated_at: 0 });
          }
        },
      };
    }
    if (/SELECT value FROM kv WHERE key/i.test(sql)) {
      return { get: (k: string) => this.rows.get(k) };
    }
    throw new Error('Unhandled SQL: ' + sql);
  }

  getKv(k: string): string | undefined {
    return this.rows.get(k)?.value;
  }
}

describe('0038_os_notify_default_on', () => {
  it('name matches', () => {
    expect(name).toBe('0038_os_notify_default_on');
  });

  it('seeds "1" on fresh db', () => {
    const d = new MockDb();
    up(d as unknown as Database.Database);
    expect(d.getKv('notifications.osEnabled')).toBe('1');
  });

  it('does not overwrite "0"', () => {
    const d = new MockDb();
    d.rows.set('notifications.osEnabled', {
      key: 'notifications.osEnabled',
      value: '0',
      updated_at: 0,
    });
    up(d as unknown as Database.Database);
    expect(d.getKv('notifications.osEnabled')).toBe('0');
  });

  it('idempotent on double run', () => {
    const d = new MockDb();
    up(d as unknown as Database.Database);
    up(d as unknown as Database.Database);
    expect(d.getKv('notifications.osEnabled')).toBe('1');
  });
});
