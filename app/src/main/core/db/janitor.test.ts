import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track which WHERE conditions were passed to the select chain.
// We use JSON.stringify on the drizzle-orm SQL node so we can assert the
// predicate text without depending on internals.
const selectWhereArgs: unknown[] = [];
const updates: Array<Record<string, unknown>> = [];
let zombieRows: Array<{ id: string; status: string; pane_index: number | null }> = [];

// The janitor uses two shapes of select:
//   db.select().from(agentSessions).where(c).all()   — sessions (with .where())
//   db.select().from(workspacesTable).all()           — workspaces (no .where())
//   db.select().from(swarmsTable).where(c).all()      — swarms (with .where())
// The .from() result must expose both .where() and .all() directly.
const fakeDrizzle = {
  select: () => ({
    from: () => ({
      // workspacesTable path: .from(t).all() with no .where()
      all: () => [] as unknown[],
      // agentSessions / swarms path: .from(t).where(c).all()
      where: (cond: unknown) => {
        selectWhereArgs.push(cond);
        return { all: () => zombieRows };
      },
    }),
  }),
  update: () => ({
    set: (vals: Record<string, unknown>) => ({
      where: () => ({ run: () => updates.push(vals) }),
    }),
  }),
};

// session-persistence fix (2026-07-18) — the supersession sweep runs through
// getRawDb (window-function UPDATE better expressed as raw SQL). Capture every
// prepared statement + its binds so the sweep's SQL contract is assertable.
const preparedSqls: string[] = [];
const sweepRuns: unknown[][] = [];
const fakeRaw = {
  prepare: (sql: string) => {
    preparedSqls.push(sql);
    return {
      all: () => [],
      run: (...args: unknown[]) => {
        if (/SET closed_at = \?/.test(sql)) {
          sweepRuns.push(args);
          return { changes: 7 };
        }
        return { changes: 0 };
      },
    };
  },
};

// janitor.ts imports getDb from './client'
vi.mock('./client', () => ({
  getDb: () => fakeDrizzle,
  getRawDb: () => fakeRaw,
}));

import { runBootJanitor } from './janitor';

beforeEach(() => {
  updates.length = 0;
  selectWhereArgs.length = 0;
  preparedSqls.length = 0;
  sweepRuns.length = 0;
});

describe('runBootJanitor', () => {
  it('marks BOTH running and starting zombies exited, preserving pane_index', async () => {
    zombieRows = [
      { id: 'a', status: 'running', pane_index: 0 },
      { id: 'b', status: 'starting', pane_index: 1 },
    ];
    const report = await runBootJanitor();
    expect(report.zombieSessionsMarked).toBe(2);

    // The zombie SELECT predicate must cover BOTH statuses.
    // drizzle-orm's inArray(col, ['running','starting']) stores the values in
    // queryChunks as an array of Param objects with a .value property. Check
    // that chunk[3] (the values array) contains a Param whose .value is
    // 'starting'. eq(col,'running') does not produce such a chunk.
    const sessionPredicate = selectWhereArgs[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const chunks = sessionPredicate?.queryChunks ?? [];
    const hasStartingInValues = chunks.some(
      (chunk) =>
        Array.isArray(chunk) &&
        (chunk as Array<{ value?: unknown }>).some((item) => item?.value === 'starting'),
    );
    expect(hasStartingInValues).toBe(true);

    // The session updates must set status='exited' and never touch pane_index.
    const sessionUpdates = updates.filter((u) => u.status === 'exited');
    expect(sessionUpdates.length).toBe(2);
    for (const u of sessionUpdates) {
      expect(u).not.toHaveProperty('paneIndex');
      expect(u).not.toHaveProperty('pane_index');
    }
  });

  it('marks nothing when there are no zombies', async () => {
    zombieRows = [];
    const report = await runBootJanitor();
    expect(report.zombieSessionsMarked).toBe(0);
    const sessionUpdates = updates.filter((u) => u.status === 'exited');
    expect(sessionUpdates.length).toBe(0);
  });

  // session-persistence fix (2026-07-18) — supersession sweep. Stale open
  // siblings (relaunch leaks, historical crashes) accumulate per slot; boot
  // auto-resume used to respawn their OLD conversations. The sweep closes
  // every open pane row that is not its slot's rank-winner, healing the
  // backlog on first boot.
  it('closes every open row that is not its slot rank-winner and reports the count', async () => {
    zombieRows = [];
    const report = await runBootJanitor();
    expect(report.supersededRowsClosed).toBe(7);

    const sweepSql = preparedSqls.find((s) => /SET closed_at = \?/.test(s));
    expect(sweepSql).toBeDefined();
    // Contract assertions — the sweep must mirror the slot-rank twins
    // (lastResumePlan / listForWorkspace / listEligibleRows):
    expect(sweepSql!).toMatch(/PARTITION BY workspace_id, pane_index/);
    expect(sweepSql!).toMatch(/closed_at IS NULL/); // only open rows get closed
    expect(sweepSql!).toMatch(/pane_index IS NOT NULL/); // legacy NULL-index rows untouched
    expect(sweepSql!).toMatch(/started_at DESC/);
    expect(sweepSql!).toMatch(/CASE WHEN status IN \('running', 'starting'\)/); // live-first rank
    // The single bind is the close timestamp.
    expect(sweepRuns).toHaveLength(1);
    expect(typeof sweepRuns[0]?.[0]).toBe('number');
  });
});
