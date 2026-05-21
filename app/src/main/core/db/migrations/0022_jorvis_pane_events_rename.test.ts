// W-6 Cluster B — Tests for migration 0022_jorvis_pane_events_rename.
//
// Uses a MockDb that tracks state in-memory and responds to the exact SQL
// patterns emitted by the migration. Verifies:
//   1. Table rename: sigma_pane_events → jorvis_pane_events.
//   2. Index rename: sigma_pane_events_conv_ts dropped, jorvis_pane_events_conv_ts created.
//   3. Column rename: sigma_monitor_conversation_id → jorvis_monitor_conversation_id.
//   4. Idempotency: running up() twice is a no-op on the second call.
//   5. Row survival: existing rows are present after migration (simulated via MockDb).
//   6. Migration name constant is set correctly.

import { describe, expect, it } from 'vitest';
import { up } from './0022_jorvis_pane_events_rename';

interface PreparedStmt {
  all: (...args: unknown[]) => unknown[];
}

class MockDb {
  tables = new Map<string, { columns: string[] }>();
  indexes = new Set<string>();
  execLog: string[] = [];

  constructor() {
    // Pre-populate the "old" schema state for these tests.
    this.tables.set('sigma_pane_events', {
      columns: ['id', 'conversation_id', 'session_id', 'kind', 'body', 'ts'],
    });
    this.tables.set('agent_sessions', {
      columns: ['id', 'workspace_id', 'sigma_monitor_conversation_id'],
    });
    this.indexes.add('sigma_pane_events_conv_ts');
  }

  exec(sql: string): void {
    const trimmed = sql.trim();
    this.execLog.push(trimmed);

    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') return;

    // ALTER TABLE <old> RENAME TO <new>
    const renameTableMatch = trimmed.match(
      /ALTER TABLE\s+(\w+)\s+RENAME TO\s+(\w+)/i,
    );
    if (renameTableMatch) {
      const [, oldName, newName] = renameTableMatch;
      const existing = this.tables.get(oldName!);
      if (existing) {
        this.tables.set(newName!, { ...existing });
        this.tables.delete(oldName!);
      }
      return;
    }

    // ALTER TABLE <table> RENAME COLUMN <old> TO <new>
    const renameColMatch = trimmed.match(
      /ALTER TABLE\s+(\w+)\s+RENAME COLUMN\s+(\w+)\s+TO\s+(\w+)/i,
    );
    if (renameColMatch) {
      const [, table, oldCol, newCol] = renameColMatch;
      const t = this.tables.get(table!);
      if (t) {
        const idx = t.columns.indexOf(oldCol!);
        if (idx !== -1) {
          t.columns.splice(idx, 1, newCol!);
        }
      }
      return;
    }

    // DROP INDEX <name>
    const dropIdxMatch = trimmed.match(/DROP INDEX\s+(\w+)/i);
    if (dropIdxMatch) {
      this.indexes.delete(dropIdxMatch[1]!);
      return;
    }

    // CREATE INDEX <name> ON ...
    const createIdxMatch = trimmed.match(/CREATE INDEX\s+(\w+)\s+ON/i);
    if (createIdxMatch) {
      this.indexes.add(createIdxMatch[1]!);
      return;
    }

    throw new Error(`MockDb.exec — unhandled SQL: ${trimmed.slice(0, 120)}`);
  }

  prepare(sql: string): PreparedStmt {
    const trimmed = sql.trim();

    // SELECT name FROM sqlite_master WHERE type='table' AND name=?
    if (trimmed.toLowerCase().startsWith("select name from sqlite_master where type='table'")) {
      return {
        all: (name: unknown) => {
          return this.tables.has(name as string) ? [{ name }] : [];
        },
      };
    }

    // SELECT name FROM sqlite_master WHERE type='index' AND name=?
    if (trimmed.toLowerCase().startsWith("select name from sqlite_master where type='index'")) {
      return {
        all: (name: unknown) => {
          return this.indexes.has(name as string) ? [{ name }] : [];
        },
      };
    }

    // PRAGMA table_info(<table>)
    const pragmaMatch = trimmed.match(/PRAGMA table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const tableName = pragmaMatch[1]!;
      return {
        all: () => {
          const t = this.tables.get(tableName);
          if (!t) return [];
          return t.columns.map((col) => ({ name: col }));
        },
      };
    }

    throw new Error(`MockDb.prepare — unhandled SQL: ${trimmed.slice(0, 80)}`);
  }
}

describe('0022_jorvis_pane_events_rename', () => {
  it('renames sigma_pane_events table to jorvis_pane_events', () => {
    const mock = new MockDb();
    up(mock as unknown as Parameters<typeof up>[0]);
    expect(mock.tables.has('jorvis_pane_events')).toBe(true);
    expect(mock.tables.has('sigma_pane_events')).toBe(false);
  });

  it('drops sigma_pane_events_conv_ts index and creates jorvis_pane_events_conv_ts', () => {
    const mock = new MockDb();
    up(mock as unknown as Parameters<typeof up>[0]);
    expect(mock.indexes.has('jorvis_pane_events_conv_ts')).toBe(true);
    expect(mock.indexes.has('sigma_pane_events_conv_ts')).toBe(false);
  });

  it('renames sigma_monitor_conversation_id column to jorvis_monitor_conversation_id', () => {
    const mock = new MockDb();
    up(mock as unknown as Parameters<typeof up>[0]);
    const cols = mock.tables.get('agent_sessions')?.columns ?? [];
    expect(cols).toContain('jorvis_monitor_conversation_id');
    expect(cols).not.toContain('sigma_monitor_conversation_id');
  });

  it('existing columns on jorvis_pane_events survive (row structural integrity)', () => {
    const mock = new MockDb();
    up(mock as unknown as Parameters<typeof up>[0]);
    const cols = mock.tables.get('jorvis_pane_events')?.columns ?? [];
    expect(cols).toContain('id');
    expect(cols).toContain('conversation_id');
    expect(cols).toContain('session_id');
    expect(cols).toContain('kind');
  });

  it('is idempotent — running up() twice produces same result', () => {
    const mock = new MockDb();
    up(mock as unknown as Parameters<typeof up>[0]);

    // Simulate a second call on an already-migrated DB (old table is gone).
    up(mock as unknown as Parameters<typeof up>[0]);

    expect(mock.tables.has('jorvis_pane_events')).toBe(true);
    expect(mock.tables.has('sigma_pane_events')).toBe(false);
    expect(mock.indexes.has('jorvis_pane_events_conv_ts')).toBe(true);
    expect(mock.indexes.has('sigma_pane_events_conv_ts')).toBe(false);
    const cols = mock.tables.get('agent_sessions')?.columns ?? [];
    expect(cols).toContain('jorvis_monitor_conversation_id');
  });

  it('migration name constant is set correctly', async () => {
    const mod = await import('./0022_jorvis_pane_events_rename');
    expect(mod.name).toBe('0022_jorvis_pane_events_rename');
  });
});
