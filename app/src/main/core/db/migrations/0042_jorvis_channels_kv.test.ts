// P3 Task 1 — tests for migration 0042_jorvis_channels_kv. Mirrors
// 0040_missions_autonomy_kv.test.ts's MockDb recording pattern (vitest runs
// on the Node ABI; better-sqlite3 is built for Electron, so a live in-memory
// DB can't be opened here).

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0042_jorvis_channels_kv';

interface KvRow {
  key: string;
  value: string;
  updated_at: number;
}

class MockDb {
  readonly rows = new Map<string, KvRow>();

  exec(): void {}

  prepare(sql: string) {
    if (/INSERT OR IGNORE INTO kv/i.test(sql)) {
      return {
        run: (key: string, value: string) => {
          if (!this.rows.has(key)) {
            this.rows.set(key, { key, value, updated_at: 0 });
          }
        },
      };
    }
    throw new Error('Unhandled SQL: ' + sql);
  }

  getKv(k: string): string | undefined {
    return this.rows.get(k)?.value;
  }
}

describe('0042_jorvis_channels_kv', () => {
  it('name matches', () => {
    expect(name).toBe('0042_jorvis_channels_kv');
  });

  it('seeds all three channel defaults on a fresh db', () => {
    const d = new MockDb();
    up(d as unknown as Database.Database);
    expect(d.getKv('remote.telegram.operatorChatId')).toBe('');
    expect(d.getKv('jorvis.brief.enabled')).toBe('0');
    expect(d.getKv('jorvis.brief.time')).toBe('09:00');
    expect(d.rows.size).toBe(3);
  });

  it('does not overwrite an operator-set operatorChatId', () => {
    const d = new MockDb();
    d.rows.set('remote.telegram.operatorChatId', {
      key: 'remote.telegram.operatorChatId',
      value: '12345',
      updated_at: 0,
    });
    up(d as unknown as Database.Database);
    expect(d.getKv('remote.telegram.operatorChatId')).toBe('12345');
  });

  it('does not overwrite an operator-set brief.enabled', () => {
    const d = new MockDb();
    d.rows.set('jorvis.brief.enabled', {
      key: 'jorvis.brief.enabled',
      value: '1',
      updated_at: 0,
    });
    up(d as unknown as Database.Database);
    expect(d.getKv('jorvis.brief.enabled')).toBe('1');
  });

  it('does not overwrite an operator-set brief.time', () => {
    const d = new MockDb();
    d.rows.set('jorvis.brief.time', {
      key: 'jorvis.brief.time',
      value: '18:30',
      updated_at: 0,
    });
    up(d as unknown as Database.Database);
    expect(d.getKv('jorvis.brief.time')).toBe('18:30');
  });

  it('is idempotent on double run', () => {
    const d = new MockDb();
    up(d as unknown as Database.Database);
    up(d as unknown as Database.Database);
    expect(d.rows.size).toBe(3);
    expect(d.getKv('remote.telegram.operatorChatId')).toBe('');
    expect(d.getKv('jorvis.brief.enabled')).toBe('0');
    expect(d.getKv('jorvis.brief.time')).toBe('09:00');
  });
});
