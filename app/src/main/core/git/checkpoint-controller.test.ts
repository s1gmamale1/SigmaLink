// P6 FEAT-11 — tests for buildGitCheckpointController.
//
// The controller resolves sessionId→worktree via the DB, calls the git-ops
// checkpoint functions (injected here as mocks), records rows, and enforces
// sha-ownership before a restore. better-sqlite3 can't load under vitest, so we
// drive it with a small MockDb modelling the agent_sessions rows + an in-memory
// session_checkpoints table, exactly the MockDb philosophy used by the
// migration tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildGitCheckpointController } from './checkpoint-controller';
import type { CheckpointDb } from './checkpoint-controller';
import { agentSessions, sessionCheckpoints } from '../db/schema';

interface SessionRow {
  id: string;
  worktreePath: string | null;
}
interface CheckpointRow {
  id: string;
  sessionId: string;
  sha: string;
  label: string | null;
  kind: 'auto' | 'manual';
  createdAt: number;
}

// A chainable fake that interprets `.from(table)` to know which table is being
// queried and applies the recorded predicate. Only the query shapes the
// controller actually uses are modelled.
class MockDb {
  sessions: SessionRow[] = [];
  checkpoints: CheckpointRow[] = [];

  // Arrow class fields capture `this` lexically (no `self` alias); the inner
  // builder uses arrow methods so it never rebinds `this` either.
  select = () => {
    let table: unknown;
    const pred: { sessionId?: string; sha?: string } = {};
    const builder = {
      from: (t: unknown) => {
        table = t;
        return builder;
      },
      // The schema's eq()/and() return opaque objects translated upstream into
      // a { __sessionId?, __sha? } side-channel; we apply it as the predicate.
      where: (cond: { __sessionId?: string; __sha?: string }) => {
        if (cond.__sessionId !== undefined) pred.sessionId = cond.__sessionId;
        if (cond.__sha !== undefined) pred.sha = cond.__sha;
        return builder;
      },
      orderBy: () => builder,
      get: () => {
        if (table === agentSessions) {
          return this.sessions.find((s) => s.id === pred.sessionId);
        }
        if (table === sessionCheckpoints) {
          return this.checkpoints.find(
            (c) =>
              (pred.sessionId === undefined || c.sessionId === pred.sessionId) &&
              (pred.sha === undefined || c.sha === pred.sha),
          );
        }
        return undefined;
      },
      all: () => {
        if (table === sessionCheckpoints) {
          return this.checkpoints
            .filter((c) => pred.sessionId === undefined || c.sessionId === pred.sessionId)
            .sort((a, b) => b.createdAt - a.createdAt);
        }
        return [];
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

// drizzle's eq()/and() are mocked so the MockDb can read back the predicate
// fields. eq() tags each condition with its column identity + value; and()
// merges the child tags into one predicate object the MockDb.where understands.
vi.mock('drizzle-orm', () => {
  const tagEq = (col: unknown, val: string) => ({ __col: col, __val: val });
  // `sql` is consumed by schema.ts (default-value templates); a passthrough
  // template tag keeps the schema module importable under this mock.
  const sqlTag = (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    __sql: strings.join('?'),
    vals,
  });
  return {
    sql: sqlTag,
    eq: tagEq,
    and: (...conds: Array<{ __col: unknown; __val: string }>) => ({
      __and: conds,
    }),
    desc: (col: unknown) => ({ __desc: col }),
  };
});

// Translate a single eq()-tag (or an and() of eq()-tags) into the
// { __sessionId?, __sha? } side-channel the MockDb.where expects, by matching
// each tag's column identity against the real schema columns.
function translatePredicate(cond: {
  __col?: unknown;
  __val?: string;
  __and?: Array<{ __col: unknown; __val: string }>;
}): { __sessionId?: string; __sha?: string } {
  const out: { __sessionId?: string; __sha?: string } = {};
  const apply = (c: { __col: unknown; __val: string }) => {
    if (c.__col === sessionCheckpoints.sha) out.__sha = c.__val;
    else out.__sessionId = c.__val; // agentSessions.id OR sessionCheckpoints.sessionId
  };
  if (cond.__and) cond.__and.forEach(apply);
  else if (cond.__col !== undefined) apply(cond as { __col: unknown; __val: string });
  return out;
}

function makeController(db: MockDb, git: {
  createCheckpoint: ReturnType<typeof vi.fn>;
  restoreCheckpoint: ReturnType<typeof vi.fn>;
}) {
  const onChanged = vi.fn();
  // Wrap the MockDb so eq()/and() tagged objects are translated to the
  // sessionId/sha side-channel the MockDb.where expects.
  const wrapped: CheckpointDb = {
    select: () => {
      const b = db.select();
      const origWhere = b.where;
      // Translate the tagged eq()/and() predicate into the side-channel the
      // MockDb builder consumes, then forward. Cast through unknown because the
      // builder's declared `where` param is the post-translation shape.
      b.where = ((cond: Parameters<typeof translatePredicate>[0]) =>
        origWhere(translatePredicate(cond))) as unknown as typeof b.where;
      return b;
    },
    insert: () => db.insert(),
  } as unknown as CheckpointDb;
  return {
    ctl: buildGitCheckpointController({
      getDb: () => wrapped,
      createCheckpoint: git.createCheckpoint as never,
      restoreCheckpoint: git.restoreCheckpoint as never,
      onChanged,
    }),
    onChanged,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildGitCheckpointController', () => {
  it('createCheckpoint resolves the worktree, calls git, and inserts a manual row', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: '/wt/sess-1' }];
    const git = {
      createCheckpoint: vi.fn().mockResolvedValue({ ok: true, sha: 'newsha' }),
      restoreCheckpoint: vi.fn(),
    };
    const { ctl, onChanged } = makeController(db, git);

    const row = await ctl.createCheckpoint({ sessionId: 'sess-1', label: 'wip' });

    expect(git.createCheckpoint).toHaveBeenCalledWith('/wt/sess-1', 'wip');
    expect(row.sha).toBe('newsha');
    expect(row.kind).toBe('manual');
    expect(row.label).toBe('wip');
    expect(db.checkpoints).toHaveLength(1);
    expect(db.checkpoints[0].sessionId).toBe('sess-1');
    expect(onChanged).toHaveBeenCalledWith('sess-1');
  });

  it('createCheckpoint throws when the session has no worktree (git not called)', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: null }];
    const git = {
      createCheckpoint: vi.fn(),
      restoreCheckpoint: vi.fn(),
    };
    const { ctl } = makeController(db, git);
    await expect(ctl.createCheckpoint({ sessionId: 'sess-1' })).rejects.toThrow(/no worktree/);
    expect(git.createCheckpoint).not.toHaveBeenCalled();
  });

  it('createCheckpoint throws (no row inserted) when the git op fails', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: '/wt' }];
    const git = {
      createCheckpoint: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
      restoreCheckpoint: vi.fn(),
    };
    const { ctl } = makeController(db, git);
    await expect(ctl.createCheckpoint({ sessionId: 'sess-1' })).rejects.toThrow(/boom/);
    expect(db.checkpoints).toHaveLength(0);
  });

  it('listCheckpoints returns this session rows newest-first', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: '/wt' }];
    db.checkpoints = [
      { id: 'c1', sessionId: 'sess-1', sha: 'a', label: 'old', kind: 'manual', createdAt: 100 },
      { id: 'c2', sessionId: 'sess-1', sha: 'b', label: 'new', kind: 'manual', createdAt: 300 },
      { id: 'c3', sessionId: 'other', sha: 'x', label: 'nope', kind: 'manual', createdAt: 999 },
    ];
    const { ctl } = makeController(db, {
      createCheckpoint: vi.fn(),
      restoreCheckpoint: vi.fn(),
    });
    const rows = await ctl.listCheckpoints('sess-1');
    expect(rows.map((r) => r.id)).toEqual(['c2', 'c1']); // newest first, other session excluded
  });

  it('restoreCheckpoint validates sha ownership, calls git, and records the auto safety row', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: '/wt' }];
    db.checkpoints = [
      { id: 'c1', sessionId: 'sess-1', sha: 'targetsha', label: 'wip', kind: 'manual', createdAt: 100 },
    ];
    const git = {
      createCheckpoint: vi.fn(),
      restoreCheckpoint: vi.fn().mockResolvedValue({ ok: true, safetySha: 'safetysha' }),
    };
    const { ctl, onChanged } = makeController(db, git);

    const out = await ctl.restoreCheckpoint({ sessionId: 'sess-1', sha: 'targetsha' });

    expect(git.restoreCheckpoint).toHaveBeenCalledWith('/wt', 'targetsha');
    expect(out).toEqual({ ok: true, safetySha: 'safetysha' });
    // The auto pre-rewind row was recorded.
    const auto = db.checkpoints.find((c) => c.kind === 'auto');
    expect(auto).toBeDefined();
    expect(auto!.sha).toBe('safetysha');
    expect(auto!.label).toBe('pre-rewind');
    expect(onChanged).toHaveBeenCalledWith('sess-1');
  });

  it('restoreCheckpoint REFUSES a sha that is not one of this session checkpoints', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: '/wt' }];
    db.checkpoints = [
      { id: 'c1', sessionId: 'sess-1', sha: 'mine', label: null, kind: 'manual', createdAt: 100 },
    ];
    const git = {
      createCheckpoint: vi.fn(),
      restoreCheckpoint: vi.fn(),
    };
    const { ctl } = makeController(db, git);
    await expect(
      ctl.restoreCheckpoint({ sessionId: 'sess-1', sha: 'foreignsha' }),
    ).rejects.toThrow(/does not belong/);
    // The destructive git op was never reached.
    expect(git.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it('restoreCheckpoint records the safety row even when the git reset fails', async () => {
    const db = new MockDb();
    db.sessions = [{ id: 'sess-1', worktreePath: '/wt' }];
    db.checkpoints = [
      { id: 'c1', sessionId: 'sess-1', sha: 'targetsha', label: null, kind: 'manual', createdAt: 100 },
    ];
    const git = {
      createCheckpoint: vi.fn(),
      restoreCheckpoint: vi
        .fn()
        .mockResolvedValue({ ok: false, safetySha: 'safetysha', error: 'reset failed' }),
    };
    const { ctl } = makeController(db, git);
    await expect(
      ctl.restoreCheckpoint({ sessionId: 'sess-1', sha: 'targetsha' }),
    ).rejects.toThrow(/reset failed/);
    // Even though the restore threw, the recoverable safety row is persisted.
    expect(db.checkpoints.some((c) => c.kind === 'auto' && c.sha === 'safetysha')).toBe(true);
  });
});
