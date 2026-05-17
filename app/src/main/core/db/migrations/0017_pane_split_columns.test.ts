import { describe, expect, it } from 'vitest';
import { up } from './0017_pane_split_columns';

interface ColumnRow {
  name: string;
}

class MockDb {
  tables = new Map<string, { columns: string[] }>();
  indexes = new Set<string>();

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
    const createIdxMatch = sql.match(/CREATE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)/i);
    if (createIdxMatch) {
      this.indexes.add(createIdxMatch[1]);
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
    if (/SELECT name FROM sqlite_master/i.test(sql)) {
      return {
        all: (name: string): { name: string }[] => {
          return this.indexes.has(name) ? [{ name }] : [];
        },
      };
    }
    throw new Error('Unhandled SQL: ' + sql);
  }
}

describe('0017_pane_split_columns', () => {
  it('adds split_group_id, split_direction, split_index, minimised columns + index', () => {
    // MockDb doesn't implement full Database interface — safe for test context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    db.tables.set('agent_sessions', { columns: [] });
    up(db);

    const table = db.tables.get('agent_sessions');
    expect(table?.columns).toContain('split_group_id');
    expect(table?.columns).toContain('split_direction');
    expect(table?.columns).toContain('split_index');
    expect(table?.columns).toContain('minimised');
    expect(db.indexes.has('agent_sessions_split_idx')).toBe(true);
  });

  it('is idempotent (up twice does not throw or duplicate)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new MockDb() as any;
    db.tables.set('agent_sessions', { columns: [] });
    up(db);
    up(db);

    const table = db.tables.get('agent_sessions');
    expect(
      table?.columns.filter((c: string) => c === 'split_group_id').length,
    ).toBe(1);
    expect(
      table?.columns.filter((c: string) => c === 'minimised').length,
    ).toBe(1);
    expect(db.indexes.size).toBe(1);
  });
});
