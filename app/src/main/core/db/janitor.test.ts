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

const fakeRaw = {
  prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
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
});
