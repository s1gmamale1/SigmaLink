import { describe, expect, it } from 'vitest';
import { up } from './0015_agent_session_sigma_monitor';

interface ColumnRow {
  name: string;
}

class MockDb {
  tables = new Map<string, { columns: string[] }>();

  exec(sql: string): void {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return;
    const alterMatch = sql.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+(.+)/i);
    if (alterMatch) {
      const tableName = alterMatch[1];
      const colName = alterMatch[2];
      const table = this.tables.get(tableName) ?? { columns: [] };
      if (!table.columns.includes(colName)) {
        table.columns.push(colName);
      }
      this.tables.set(tableName, table);
      return;
    }
    throw new Error('Unhandled SQL: ' + sql);
  }

  prepare(sql: string) {
    const pragmaMatch = sql.match(/PRAGMA table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const tableName = pragmaMatch[1];
      return {
        all: (): ColumnRow[] => {
          const table = this.tables.get(tableName) ?? { columns: [] };
          return table.columns.map((name) => ({ name }));
        },
      };
    }
    throw new Error('Unhandled SQL: ' + sql);
  }
}

describe('0015_agent_session_sigma_monitor', () => {
  it('is idempotent (up twice does not throw)', () => {
    // MockDb doesn't implement full Database interface — safe for test context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    db.tables.set('agent_sessions', { columns: [] });
    up(db);
    up(db);
    const table = db.tables.get('agent_sessions');
    expect(table?.columns).toContain('sigma_monitor_conversation_id');
    expect(table?.columns.filter((c: string) => c === 'sigma_monitor_conversation_id').length).toBe(1);
  });
});
