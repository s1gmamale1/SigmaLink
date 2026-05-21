// v1.5.5 Cluster A — test for migration 0020_agent_session_pane_unique.
//
// Uses a MockDb that tracks rows in-memory and responds to the exact SQL
// patterns emitted by the migration.  Verifies:
//   1. Dedup — duplicate rows for the same (workspace_id, pane_index) are
//      removed; the most-recent `started_at` row survives.
//   2. NULL rows — rows with pane_index IS NULL are untouched by the dedup.
//   3. Unique index — `agent_sessions_ws_pane_uq` is created after the dedup.
//   4. Already-unique DB — no rows deleted, index still created.
//   5. Idempotency — running `up` twice is a no-op on the second call.
//   6. Tie-breaker — when started_at values are equal, the row with the
//      lexicographically higher `id` survives.

import { describe, expect, it } from 'vitest';
import { up } from './0020_agent_session_pane_unique';

interface SessionRow {
  id: string;
  workspace_id: string;
  pane_index: number | null;
  started_at: number;
}

class MockDb {
  rows: SessionRow[] = [];
  indexes = new Set<string>();
  exec(sql: string): void {
    const trimmed = sql.trim();
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return;
    }

    // CREATE UNIQUE INDEX
    const idxMatch = trimmed.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/i,
    );
    if (idxMatch) {
      this.indexes.add(idxMatch[1]);
      return;
    }

    // DELETE dedup statement — simulate the ROW_NUMBER logic in JS
    if (/DELETE FROM agent_sessions/i.test(trimmed)) {
      // Build a map of winners: for each (workspace_id, pane_index) keep the
      // row with highest started_at, tie-break by highest id lexicographically.
      const paneRows = this.rows.filter((r) => r.pane_index !== null);
      const winnerIds = new Set<string>();

      const groups = new Map<string, SessionRow[]>();
      for (const r of paneRows) {
        const key = `${r.workspace_id}::${r.pane_index}`;
        const g = groups.get(key) ?? [];
        g.push(r);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        g.sort((a, b) => {
          if (b.started_at !== a.started_at) return b.started_at - a.started_at;
          return b.id > a.id ? 1 : -1;
        });
        winnerIds.add(g[0].id);
      }

      // Delete non-winners among pane rows
      this.rows = this.rows.filter(
        (r) => r.pane_index === null || winnerIds.has(r.id),
      );
      return;
    }

    throw new Error(`MockDb.exec — unhandled SQL: ${trimmed.slice(0, 80)}`);
  }

  prepare(sql: string) {
    // Used by hasIndex()
    if (/SELECT name FROM sqlite_master WHERE type = 'index'/i.test(sql)) {
      return {
        all: (idxName: string): { name: string }[] =>
          this.indexes.has(idxName) ? [{ name: idxName }] : [],
      };
    }
    throw new Error(`MockDb.prepare — unhandled SQL: ${sql.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(
  id: string,
  workspaceId: string,
  paneIndex: number | null,
  startedAt: number,
): SessionRow {
  return { id, workspace_id: workspaceId, pane_index: paneIndex, started_at: startedAt };
}

const T = 1_000_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('0020_agent_session_pane_unique', () => {
  it('creates the partial unique index on a fresh (no rows) DB', () => {
    const db = new MockDb() as unknown as Parameters<typeof up>[0];
    up(db);
    expect((db as unknown as MockDb).indexes.has('agent_sessions_ws_pane_uq')).toBe(true);
  });

  it('does not delete rows when there are no duplicates', () => {
    const mock = new MockDb();
    mock.rows = [
      row('s1', 'ws1', 0, T),
      row('s2', 'ws1', 1, T),
      row('s3', 'ws2', 0, T),
    ];
    up(mock as unknown as Parameters<typeof up>[0]);
    expect(mock.rows).toHaveLength(3);
    expect(mock.indexes.has('agent_sessions_ws_pane_uq')).toBe(true);
  });

  it('deduplicates rows — keeps the most-recent started_at', () => {
    const mock = new MockDb();
    mock.rows = [
      row('old', 'ws1', 0, T - 1000),   // older — should be deleted
      row('new', 'ws1', 0, T),           // newer — should survive
    ];
    up(mock as unknown as Parameters<typeof up>[0]);
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].id).toBe('new');
  });

  it('deduplicates rows — tie on started_at, keeps lexicographically higher id', () => {
    const mock = new MockDb();
    mock.rows = [
      row('aaa', 'ws1', 0, T), // lower id — deleted
      row('zzz', 'ws1', 0, T), // higher id — survives
    ];
    up(mock as unknown as Parameters<typeof up>[0]);
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].id).toBe('zzz');
  });

  it('does not touch rows where pane_index IS NULL', () => {
    const mock = new MockDb();
    mock.rows = [
      row('null1', 'ws1', null, T - 500),
      row('null2', 'ws1', null, T),
      row('dup-old', 'ws1', 0, T - 1000),
      row('dup-new', 'ws1', 0, T),
    ];
    up(mock as unknown as Parameters<typeof up>[0]);

    // Both NULL rows survive
    const nullRows = mock.rows.filter((r) => r.pane_index === null);
    expect(nullRows).toHaveLength(2);

    // Only one pane-0 row survives (the newer)
    const pane0Rows = mock.rows.filter((r) => r.pane_index === 0);
    expect(pane0Rows).toHaveLength(1);
    expect(pane0Rows[0].id).toBe('dup-new');
  });

  it('handles multiple duplicate groups independently', () => {
    const mock = new MockDb();
    mock.rows = [
      row('ws1-p0-old', 'ws1', 0, T - 500),
      row('ws1-p0-new', 'ws1', 0, T),
      row('ws1-p1-old', 'ws1', 1, T - 200),
      row('ws1-p1-new', 'ws1', 1, T),
      row('ws2-p0-only', 'ws2', 0, T),
    ];
    up(mock as unknown as Parameters<typeof up>[0]);
    expect(mock.rows).toHaveLength(3);
    const ids = mock.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['ws1-p0-new', 'ws1-p1-new', 'ws2-p0-only'].sort());
  });

  it('is idempotent — running up twice produces same result', () => {
    const mock = new MockDb();
    mock.rows = [
      row('old', 'ws1', 0, T - 1000),
      row('new', 'ws1', 0, T),
    ];
    up(mock as unknown as Parameters<typeof up>[0]);
    const afterFirst = mock.rows.map((r) => r.id);
    const indexCountAfterFirst = mock.indexes.size;

    up(mock as unknown as Parameters<typeof up>[0]);
    const afterSecond = mock.rows.map((r) => r.id);

    expect(afterSecond).toEqual(afterFirst);
    expect(mock.indexes.size).toBe(indexCountAfterFirst);
  });
});
