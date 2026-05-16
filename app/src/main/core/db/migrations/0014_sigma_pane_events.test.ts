import { describe, expect, it } from 'vitest';
import { up } from './0014_sigma_pane_events';

class MockDb {
  tables = new Set<string>();
  indexes = new Set<string>();

  exec(sql: string): void {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return;
    const tableMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
    if (tableMatch) {
      this.tables.add(tableMatch[1]);
      return;
    }
    const indexMatch = sql.match(/CREATE INDEX IF NOT EXISTS\s+(\w+)/i);
    if (indexMatch) {
      this.indexes.add(indexMatch[1]);
      return;
    }
    throw new Error('Unhandled SQL: ' + sql);
  }
}

describe('0014_sigma_pane_events', () => {
  it('is idempotent (up twice does not throw)', () => {
    // MockDb doesn't implement full Database interface — safe for test context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    up(db);
    up(db);
    expect(db.tables.has('sigma_pane_events')).toBe(true);
    expect(db.indexes.has('sigma_pane_events_conv_ts')).toBe(true);
  });
});
