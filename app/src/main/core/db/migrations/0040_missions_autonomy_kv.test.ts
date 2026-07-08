// P1b Task 5 — tests for migration 0040_missions_autonomy_kv. Mirrors
// 0038_os_notify_default_on.test.ts's MockDb recording pattern (vitest runs
// on the Node ABI; better-sqlite3 is built for Electron, so a live in-memory
// DB can't be opened here).

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { name, up } from './0040_missions_autonomy_kv';

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

describe('0040_missions_autonomy_kv', () => {
  it('name matches', () => {
    expect(name).toBe('0040_missions_autonomy_kv');
  });

  it('seeds all three autonomy defaults on a fresh db', () => {
    const d = new MockDb();
    up(d as unknown as Database.Database);
    expect(d.getKv('missions.autonomy.enabled')).toBe('0');
    expect(d.getKv('missions.autonomy.dailyBudget')).toBe('40');
    expect(d.getKv('missions.autonomy.quietHours')).toBe('');
    expect(d.rows.size).toBe(3);
  });

  it('does not overwrite an operator-set enabled=1', () => {
    const d = new MockDb();
    d.rows.set('missions.autonomy.enabled', {
      key: 'missions.autonomy.enabled',
      value: '1',
      updated_at: 0,
    });
    up(d as unknown as Database.Database);
    expect(d.getKv('missions.autonomy.enabled')).toBe('1');
  });

  it('does not overwrite an operator-set dailyBudget', () => {
    const d = new MockDb();
    d.rows.set('missions.autonomy.dailyBudget', {
      key: 'missions.autonomy.dailyBudget',
      value: '100',
      updated_at: 0,
    });
    up(d as unknown as Database.Database);
    expect(d.getKv('missions.autonomy.dailyBudget')).toBe('100');
  });

  it('is idempotent on double run', () => {
    const d = new MockDb();
    up(d as unknown as Database.Database);
    up(d as unknown as Database.Database);
    expect(d.rows.size).toBe(3);
    expect(d.getKv('missions.autonomy.enabled')).toBe('0');
    expect(d.getKv('missions.autonomy.dailyBudget')).toBe('40');
    expect(d.getKv('missions.autonomy.quietHours')).toBe('');
  });
});
