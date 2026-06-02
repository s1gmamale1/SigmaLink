// FEAT-11 fast-follow — tests for `maybeAutoCheckpoint`.
//
// The helper is gated (KV), change-checked (`git status --porcelain`), and
// min-interval-throttled, then creates a `kind:'auto'` checkpoint + records a
// row. better-sqlite3 can't load under vitest, so we drive it with a small
// MockDb modelling the session_checkpoints table and inject mocked seams
// (readGate / getPorcelain / createCheckpoint / now) so no real git, fs, or DB
// is touched. drizzle-orm is mocked the same way as checkpoint-controller.test.
//
// The load-bearing assertions:
//   - gate OFF            → no createCheckpoint, no row
//   - clean tree          → no createCheckpoint, no row
//   - within min-interval → no createCheckpoint, no row
//   - dirty + enabled     → createCheckpoint('/wt','pre-dispatch') + kind:'auto' row
//   - createCheckpoint throws → fail-open (resolves, no row)
//   - no worktree         → no-op

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sessionCheckpoints } from '../db/schema';
import {
  maybeAutoCheckpoint,
  AUTO_CHECKPOINT_LABEL,
  MIN_INTERVAL_MS,
  type AutoCheckpointDb,
} from './auto-checkpoint';

// drizzle's eq()/and()/desc() are mocked so the MockDb can read back the
// predicate fields. Mirrors checkpoint-controller.test.ts.
vi.mock('drizzle-orm', () => {
  const tagEq = (col: unknown, val: string) => ({ __col: col, __val: val });
  const sqlTag = (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    __sql: strings.join('?'),
    vals,
  });
  return {
    sql: sqlTag,
    eq: tagEq,
    and: (...conds: Array<{ __col: unknown; __val: string }>) => ({ __and: conds }),
    desc: (col: unknown) => ({ __desc: col }),
  };
});

interface CheckpointRow {
  id: string;
  sessionId: string;
  sha: string;
  label: string | null;
  kind: 'auto' | 'manual';
  createdAt: number;
}

// Translate the eq()/and() tags into a { sessionId?, kind? } side-channel.
function translatePredicate(cond: {
  __col?: unknown;
  __val?: string;
  __and?: Array<{ __col: unknown; __val: string }>;
}): { sessionId?: string; kind?: string } {
  const out: { sessionId?: string; kind?: string } = {};
  const apply = (c: { __col: unknown; __val: string }) => {
    if (c.__col === sessionCheckpoints.kind) out.kind = c.__val;
    else out.sessionId = c.__val; // sessionCheckpoints.sessionId
  };
  if (cond.__and) cond.__and.forEach(apply);
  else if (cond.__col !== undefined) apply(cond as { __col: unknown; __val: string });
  return out;
}

// A chainable fake supporting select().from().where().orderBy().get() (the
// last-auto query) and insert().values().run().
class MockDb {
  checkpoints: CheckpointRow[] = [];

  select = () => {
    const pred: { sessionId?: string; kind?: string } = {};
    const builder = {
      from: () => builder,
      where: (cond: Parameters<typeof translatePredicate>[0]) => {
        Object.assign(pred, translatePredicate(cond));
        return builder;
      },
      orderBy: () => builder,
      get: () => {
        const matches = this.checkpoints
          .filter(
            (c) =>
              (pred.sessionId === undefined || c.sessionId === pred.sessionId) &&
              (pred.kind === undefined || c.kind === pred.kind),
          )
          .sort((a, b) => b.createdAt - a.createdAt);
        return matches[0];
      },
    };
    return builder;
  };

  insert = () => ({
    values: (row: CheckpointRow) => ({
      run: () => {
        this.checkpoints.push(row);
      },
    }),
  });
}

function wrap(db: MockDb): () => AutoCheckpointDb {
  return () => db as unknown as AutoCheckpointDb;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maybeAutoCheckpoint', () => {
  it('gate OFF → no checkpoint, no row', async () => {
    const db = new MockDb();
    const createCheckpoint = vi.fn();
    const getPorcelain = vi.fn().mockResolvedValue(' M file.ts\n');

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: '/wt',
      getDb: wrap(db),
      readGate: () => false,
      getPorcelain,
      createCheckpoint: createCheckpoint as never,
    });

    expect(createCheckpoint).not.toHaveBeenCalled();
    // change-check must not even run when the gate is off (cheap-guards-first).
    expect(getPorcelain).not.toHaveBeenCalled();
    expect(db.checkpoints).toHaveLength(0);
  });

  it('clean tree → no checkpoint, no row', async () => {
    const db = new MockDb();
    const createCheckpoint = vi.fn();

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: '/wt',
      getDb: wrap(db),
      readGate: () => true,
      getPorcelain: vi.fn().mockResolvedValue('   \n'), // whitespace-only = clean
      createCheckpoint: createCheckpoint as never,
    });

    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(db.checkpoints).toHaveLength(0);
  });

  it('within min-interval → no checkpoint, no row', async () => {
    const db = new MockDb();
    const tNow = 1_000_000;
    db.checkpoints = [
      {
        id: 'c1',
        sessionId: 'sess-1',
        sha: 'recentsha',
        label: AUTO_CHECKPOINT_LABEL,
        kind: 'auto',
        createdAt: tNow - (MIN_INTERVAL_MS - 1), // just inside the window
      },
    ];
    const createCheckpoint = vi.fn();
    const getPorcelain = vi.fn().mockResolvedValue(' M file.ts\n');

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: '/wt',
      getDb: wrap(db),
      readGate: () => true,
      getPorcelain,
      createCheckpoint: createCheckpoint as never,
      now: () => tNow,
    });

    expect(createCheckpoint).not.toHaveBeenCalled();
    // change-check is gated behind the min-interval guard.
    expect(getPorcelain).not.toHaveBeenCalled();
    expect(db.checkpoints).toHaveLength(1); // unchanged
  });

  it('dirty + enabled → createCheckpoint(pre-dispatch) + kind:auto row', async () => {
    const db = new MockDb();
    const tNow = 5_000_000;
    const createCheckpoint = vi.fn().mockResolvedValue({ ok: true, sha: 'freshsha' });

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: '/wt',
      getDb: wrap(db),
      readGate: () => true,
      getPorcelain: vi.fn().mockResolvedValue(' M file.ts\n?? new.ts\n'),
      createCheckpoint: createCheckpoint as never,
      now: () => tNow,
    });

    expect(createCheckpoint).toHaveBeenCalledWith('/wt', AUTO_CHECKPOINT_LABEL);
    expect(db.checkpoints).toHaveLength(1);
    expect(db.checkpoints[0]).toMatchObject({
      sessionId: 'sess-1',
      sha: 'freshsha',
      label: AUTO_CHECKPOINT_LABEL,
      kind: 'auto',
      createdAt: tNow,
    });
  });

  it('past min-interval → checkpoint IS taken (stale prior auto row)', async () => {
    const db = new MockDb();
    const tNow = 5_000_000;
    db.checkpoints = [
      {
        id: 'c1',
        sessionId: 'sess-1',
        sha: 'oldsha',
        label: AUTO_CHECKPOINT_LABEL,
        kind: 'auto',
        createdAt: tNow - (MIN_INTERVAL_MS + 1), // just outside the window
      },
    ];
    const createCheckpoint = vi.fn().mockResolvedValue({ ok: true, sha: 'freshsha' });

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: '/wt',
      getDb: wrap(db),
      readGate: () => true,
      getPorcelain: vi.fn().mockResolvedValue(' M file.ts\n'),
      createCheckpoint: createCheckpoint as never,
      now: () => tNow,
    });

    expect(createCheckpoint).toHaveBeenCalledOnce();
    expect(db.checkpoints).toHaveLength(2);
    expect(db.checkpoints.some((c) => c.sha === 'freshsha' && c.kind === 'auto')).toBe(true);
  });

  it('createCheckpoint returning ok:false → no row (soft failure)', async () => {
    const db = new MockDb();
    const createCheckpoint = vi.fn().mockResolvedValue({ ok: false, error: 'boom' });

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: '/wt',
      getDb: wrap(db),
      readGate: () => true,
      getPorcelain: vi.fn().mockResolvedValue(' M file.ts\n'),
      createCheckpoint: createCheckpoint as never,
    });

    expect(createCheckpoint).toHaveBeenCalledOnce();
    expect(db.checkpoints).toHaveLength(0);
  });

  it('fail-open: createCheckpoint THROWS → resolves, no row, no throw', async () => {
    const db = new MockDb();
    const createCheckpoint = vi.fn().mockRejectedValue(new Error('git exploded'));

    await expect(
      maybeAutoCheckpoint({
        sessionId: 'sess-1',
        worktreePath: '/wt',
        getDb: wrap(db),
        readGate: () => true,
        getPorcelain: vi.fn().mockResolvedValue(' M file.ts\n'),
        createCheckpoint: createCheckpoint as never,
      }),
    ).resolves.toBeUndefined();

    expect(db.checkpoints).toHaveLength(0);
  });

  it('fail-open: getPorcelain THROWS → resolves, no checkpoint, no row', async () => {
    const db = new MockDb();
    const createCheckpoint = vi.fn();

    await expect(
      maybeAutoCheckpoint({
        sessionId: 'sess-1',
        worktreePath: '/wt',
        getDb: wrap(db),
        readGate: () => true,
        getPorcelain: vi.fn().mockRejectedValue(new Error('status exploded')),
        createCheckpoint: createCheckpoint as never,
      }),
    ).resolves.toBeUndefined();

    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(db.checkpoints).toHaveLength(0);
  });

  it('no worktree → no-op (gate never even read)', async () => {
    const db = new MockDb();
    const createCheckpoint = vi.fn();
    const readGate = vi.fn().mockReturnValue(true);

    await maybeAutoCheckpoint({
      sessionId: 'sess-1',
      worktreePath: null,
      getDb: wrap(db),
      readGate,
      getPorcelain: vi.fn(),
      createCheckpoint: createCheckpoint as never,
    });

    expect(readGate).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(db.checkpoints).toHaveLength(0);
  });
});
