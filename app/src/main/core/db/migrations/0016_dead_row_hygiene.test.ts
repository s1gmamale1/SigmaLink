import { describe, expect, it, vi, afterEach } from 'vitest';
import { up } from './0016_dead_row_hygiene';

// ---------------------------------------------------------------------------
// Minimal better-sqlite3 mock that runs a real in-memory SQL store.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  status: string;
  exited_at: number | null;
  started_at: number;
  exit_code: number | null;
}

class InMemoryDb {
  private rows: Row[] = [];
  private _hasTable = true;

  withoutTable(): this {
    this._hasTable = false;
    return this;
  }

  seed(rows: Row[]): this {
    this.rows.push(...rows);
    return this;
  }

  prepare(sql: string) {
    if (!this._hasTable) {
      // Simulate missing table — throw on prepare (like SQLite would if table doesn't exist).
      throw new Error("no such table: agent_sessions");
    }
    // We only need to support the UPDATE statement used by the migration.
    const isUpdate = /^\s*UPDATE\s+agent_sessions/i.test(sql);
    if (!isUpdate) throw new Error(`Unhandled SQL in test: ${sql}`);

    return {
      run: (exitedAt: number, cutoff: number) => {
        let changes = 0;
        for (const row of this.rows) {
          if (
            row.status === 'running' &&
            row.exited_at === null &&
            row.started_at < cutoff
          ) {
            row.status = 'exited';
            row.exit_code = -1;
            row.exited_at = exitedAt;
            changes++;
          }
        }
        return { changes };
      },
    };
  }

  getRows(): Row[] {
    return this.rows;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now();
const H24 = 24 * 60 * 60 * 1000;

function row(
  id: string,
  status: string,
  startedAt: number,
  exitedAt: number | null = null,
  exitCode: number | null = null,
): Row {
  return { id, status, started_at: startedAt, exited_at: exitedAt, exit_code: exitCode };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('0016_dead_row_hygiene', () => {
  it('1. fresh DB (no agent_sessions table) — runs without throwing; logs warning', () => {
    const db = new InMemoryDb().withoutTable();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => up(db as any)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[migrate0016] Skipped'),
      expect.anything(),
    );
  });

  it('2. DB with no rows — runs; no rows affected', () => {
    const db = new InMemoryDb();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    expect(db.getRows()).toHaveLength(0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('3. row newer than 24h, status=running — untouched', () => {
    const db = new InMemoryDb().seed([
      row('a', 'running', now - H24 + 1000), // 1s inside the 24h window
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const r = db.getRows()[0];
    expect(r.status).toBe('running');
    expect(r.exited_at).toBeNull();
  });

  it('4. row older than 24h, status=running, exited_at IS NULL — marked exited', () => {
    const staleStart = now - H24 - 1000; // 1s outside the 24h window
    const db = new InMemoryDb().seed([row('b', 'running', staleStart)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const r = db.getRows()[0];
    expect(r.status).toBe('exited');
    expect(r.exit_code).toBe(-1);
    expect(r.exited_at).toBeGreaterThan(0);
    expect(r.exited_at).toBeLessThanOrEqual(Date.now() + 5);
  });

  it('5. row older than 24h, status=exited already — untouched (idempotent)', () => {
    const staleStart = now - H24 - 1000;
    const db = new InMemoryDb().seed([
      row('c', 'exited', staleStart, staleStart + 500, 0),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const r = db.getRows()[0];
    expect(r.status).toBe('exited');
    expect(r.exit_code).toBe(0); // unchanged
  });

  it('6. row older than 24h, status=running, exited_at already set — untouched', () => {
    const staleStart = now - H24 - 1000;
    const db = new InMemoryDb().seed([
      row('d', 'running', staleStart, staleStart + 100), // exited_at is set
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const r = db.getRows()[0];
    expect(r.status).toBe('running'); // WHERE exited_at IS NULL → not matched
  });

  it('7. idempotency — running migration twice has same effect as once', () => {
    const staleStart = now - H24 - 1000;
    const db = new InMemoryDb().seed([row('e', 'running', staleStart)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const afterFirst = { ...db.getRows()[0] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const afterSecond = db.getRows()[0];
    expect(afterSecond.status).toBe(afterFirst.status);
    expect(afterSecond.exit_code).toBe(afterFirst.exit_code);
    // exited_at might differ by a ms but both should be set
    expect(afterSecond.exited_at).not.toBeNull();
  });

  it('8. mixed batch — correct partition of stale/fresh/already-exited rows', () => {
    const staleStart = now - H24 - 1000;
    const freshStart = now - H24 + 5000;
    const db = new InMemoryDb().seed([
      row('stale-running-1', 'running', staleStart),       // MUST be updated
      row('stale-running-2', 'running', staleStart - 5000), // MUST be updated
      row('fresh-running', 'running', freshStart),           // untouched
      row('already-exited', 'exited', staleStart, staleStart + 1, 0), // untouched
      row('stale-exited_set', 'running', staleStart, staleStart + 1), // exited_at set → untouched
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up(db as any);
    const byId = Object.fromEntries(db.getRows().map((r) => [r.id, r]));

    // Updated
    expect(byId['stale-running-1'].status).toBe('exited');
    expect(byId['stale-running-1'].exit_code).toBe(-1);
    expect(byId['stale-running-2'].status).toBe('exited');
    expect(byId['stale-running-2'].exit_code).toBe(-1);

    // Untouched
    expect(byId['fresh-running'].status).toBe('running');
    expect(byId['already-exited'].status).toBe('exited');
    expect(byId['already-exited'].exit_code).toBe(0);
    expect(byId['stale-exited_set'].status).toBe('running');
  });
});
