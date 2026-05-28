import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { allocateLowestFreeLivePaneIndex, lowestFreePaneIndex } from './pane-slots';

class RecordingDb {
  sql = '';
  private readonly rows: Array<{ pane_index: number | null; status: string }>;

  constructor(rows: Array<{ pane_index: number | null; status: string }> = []) {
    this.rows = rows;
  }

  prepare(sql: string) {
    this.sql = sql.trim().replace(/\s+/g, ' ');
    return {
      all: (): Array<{ pane_index: number | null; status: string }> => this.rows,
    };
  }
}

describe('lowestFreePaneIndex', () => {
  it('returns 0 for an empty live set', () => {
    expect(lowestFreePaneIndex([])).toBe(0);
  });

  it('fills the first gap in occupied slots', () => {
    expect(lowestFreePaneIndex([0, 1, 3, 4])).toBe(2);
  });

  it('ignores duplicate, negative, and non-integer values', () => {
    expect(lowestFreePaneIndex([0, 0, -1, 1.5, 2])).toBe(1);
  });

  it('appends after the highest contiguous occupied slot', () => {
    expect(lowestFreePaneIndex([2, 0, 1])).toBe(3);
  });
});

describe('allocateLowestFreeLivePaneIndex', () => {
  it('queries only non-null live workspace pane slots', () => {
    const db = new RecordingDb([]);

    expect(
      allocateLowestFreeLivePaneIndex(db as unknown as Database.Database, 'ws-1'),
    ).toBe(0);
    expect(db.sql).toContain('FROM agent_sessions');
    expect(db.sql).toContain('WHERE workspace_id = ?');
    expect(db.sql).toContain('pane_index IS NOT NULL');
    expect(db.sql).toContain("status IN ('running', 'starting')");
  });

  it('allocates from rows returned by the live-slot query', () => {
    const db = new RecordingDb([
      { pane_index: 0, status: 'running' },
      { pane_index: 2, status: 'starting' },
    ]);

    expect(
      allocateLowestFreeLivePaneIndex(db as unknown as Database.Database, 'ws-1'),
    ).toBe(1);
  });
});
