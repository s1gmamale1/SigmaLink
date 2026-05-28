// SF-12 pending data-repair migration tests.
//
// This migration is intentionally not registered in ALL_MIGRATIONS until the
// operator signs off. These tests exercise the emitted SQL and rollback hooks
// with a recording mock; they never instantiate better-sqlite3.

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { down, name, up } from './0026_sf12_pane_slot_repair.pending';

interface PreimageRow {
  id: string;
  pane_index: number | null;
  status: string;
}

class RecordingDb {
  statements: string[] = [];
  kv = new Map<string, string>();
  countRows: number[] = [0, 0, 0];
  preimageRows: PreimageRow[] = [
    { id: 'terminal-1', pane_index: 0, status: 'exited' },
    { id: 'live-1', pane_index: 1, status: 'running' },
  ];

  prepare = (sql: string) => {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    this.statements.push(normalized);
    return {
      all: (): PreimageRow[] => {
        if (/SELECT id, pane_index, status FROM agent_sessions/i.test(normalized)) {
          return this.preimageRows;
        }
        return [];
      },
      get: (key?: string): Record<string, unknown> | undefined => {
        if (/SELECT COUNT\(\*\) AS cnt/i.test(normalized)) {
          return { cnt: this.countRows.shift() ?? 0 };
        }
        if (/SELECT value FROM kv WHERE key = \?/i.test(normalized) && key) {
          const value = this.kv.get(key);
          return value ? { value } : undefined;
        }
        if (/SELECT key FROM kv/i.test(normalized)) {
          const latest = [...this.kv.keys()].sort().at(-1);
          return latest ? { key: latest } : undefined;
        }
        return undefined;
      },
      run: (...params: unknown[]): { changes: number; lastInsertRowid: number } => {
        if (/INSERT OR REPLACE INTO kv/i.test(normalized)) {
          this.kv.set(String(params[0]), String(params[1]));
        }
        return { changes: 1, lastInsertRowid: 1 };
      },
    };
  };
}

function emittedSql(db = new RecordingDb()): string {
  up(db as unknown as Database.Database, 1_700_000_000_000);
  return db.statements.join('\n');
}

describe('0026_sf12_pane_slot_repair.pending', () => {
  it('migration name constant matches the approved future migration name', () => {
    expect(name).toBe('0026_sf12_pane_slot_repair');
  });

  it('captures a kv preimage before mutating rows', () => {
    const db = new RecordingDb();
    const key = up(db as unknown as Database.Database, 1_700_000_000_000);
    expect(key).toBe('sf12.preimage.1700000000000');
    expect(db.kv.has(key)).toBe(true);
    expect(db.statements[0]).toMatch(/SELECT id, pane_index, status FROM agent_sessions/i);
    expect(db.statements[1]).toMatch(/INSERT OR REPLACE INTO kv/i);
    expect(db.statements[2]).toMatch(/UPDATE agent_sessions SET pane_index = NULL/i);
  });

  it('nulls terminal slots and re-slots live rows through temporary unique slots', () => {
    const sql = emittedSql();
    expect(sql).toContain("status NOT IN ('running', 'starting')");
    expect(sql).toContain('-1 - ROW_NUMBER() OVER');
    expect(sql).toContain('PARTITION BY workspace_id');
    expect(sql).toContain('ORDER BY started_at ASC, id ASC');
  });

  it('verifies live rows have unique contiguous non-null pane indexes', () => {
    const sql = emittedSql();
    expect(sql).toContain("status IN ('running', 'starting') AND pane_index IS NULL");
    expect(sql).toContain('HAVING COUNT(*) > 1');
    expect(sql).toContain('HAVING min_idx != 0 OR max_idx != n - 1 OR uniq != n');
  });

  it('does not emit BEGIN, COMMIT, ROLLBACK, or use db.transaction', () => {
    const sql = emittedSql();
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|transaction/i);
  });

  it('down restores pane_index and status from the captured preimage', () => {
    const db = new RecordingDb();
    const key = up(db as unknown as Database.Database, 1_700_000_000_000);
    db.statements = [];

    down(db as unknown as Database.Database, key);

    const sql = db.statements.join('\n');
    expect(sql).toContain('SELECT value FROM kv WHERE key = ?');
    expect(sql).toContain('UPDATE agent_sessions SET pane_index = ?, status = ? WHERE id = ?');
  });

  it('rolls back from the preimage and throws when post-condition verification fails', () => {
    const db = new RecordingDb();
    db.countRows = [1];

    expect(() => up(db as unknown as Database.Database, 1_700_000_000_000)).toThrow(
      /live rows have NULL pane_index/,
    );
    expect(db.statements.join('\n')).toContain(
      'UPDATE agent_sessions SET pane_index = ?, status = ? WHERE id = ?',
    );
  });
});
