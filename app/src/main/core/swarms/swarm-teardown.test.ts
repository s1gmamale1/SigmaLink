// BSP-G5 — tests for post-swarm worktree teardown.
//
// Uses MockDb raw-stubs and fake worktreePool spies.
// NEVER calls `new Database()` (better-sqlite3 is not available under vitest ABI).

import { describe, it, expect, vi } from 'vitest';
import { applyTeardownPolicy } from './swarm-teardown';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 86_400 * 1_000;

type CandidateRow = {
  session_id: string;
  worktree_path: string | null;
  status: string;
  exit_code: number | null;
  exited_at: number | null;
  decision: string | null;
};

/** Build a raw-db stub that serves a KV value and a candidate-row list. */
function makeRawDb(kvValue: string | undefined, rows: CandidateRow[]) {
  return {
    prepare: (sql: string) => ({
      get: () =>
        kvValue === undefined ? undefined : { value: kvValue },
      all: () => {
        // The SQL in swarm-teardown.ts always mentions swarm_agents — use that
        // as the discriminant to serve candidate rows.
        if (sql.includes('swarm_agents')) return rows;
        return [];
      },
    }),
  };
}

/** Build a fake worktreePool. */
function makePool() {
  const removeAndPrune = vi.fn().mockResolvedValue(undefined);
  return { removeAndPrune };
}

const REPO_ROOT = '/home/user/repo';
const SWARM_ID = 'swarm-1';
const WS_ID = 'ws-1';

function makeArgs(
  kvValue: string | undefined,
  rows: CandidateRow[],
  pool = makePool(),
) {
  return {
    swarmId: SWARM_ID,
    workspaceId: WS_ID,
    repoRoot: REPO_ROOT,
    rawDb: makeRawDb(kvValue, rows) as unknown as ReturnType<
      typeof import('../db/client').getRawDb
    >,
    worktreePool: pool,
  };
}

// ---------------------------------------------------------------------------
// Base session factory
// ---------------------------------------------------------------------------

function session(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    session_id: 'sess-1',
    worktree_path: '/wt/sess-1',
    status: 'exited',
    exit_code: 0,
    exited_at: Date.now() - SEVEN_DAYS_MS - 1_000, // just outside the 7d window
    decision: 'failed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// keep-all (default)
// ---------------------------------------------------------------------------

describe('applyTeardownPolicy — keep-all', () => {
  it('is a no-op when policy is keep-all (explicit)', async () => {
    const pool = makePool();
    await applyTeardownPolicy(makeArgs('keep-all', [session()], pool));
    expect(pool.removeAndPrune).not.toHaveBeenCalled();
  });

  it('is a no-op when policy row is absent (default keep-all)', async () => {
    const pool = makePool();
    await applyTeardownPolicy(makeArgs(undefined, [session()], pool));
    expect(pool.removeAndPrune).not.toHaveBeenCalled();
  });

  it('is a no-op when policy value is garbage', async () => {
    const pool = makePool();
    await applyTeardownPolicy(makeArgs('nuke-all', [session()], pool));
    expect(pool.removeAndPrune).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// destroy-failing / keep-passing — remove eligible sessions
// ---------------------------------------------------------------------------

describe.each(['destroy-failing', 'keep-passing'] as const)(
  'applyTeardownPolicy — %s',
  (policy) => {
    it('removes a session with decision=failed', async () => {
      const pool = makePool();
      const row = session({ decision: 'failed' });
      await applyTeardownPolicy(makeArgs(policy, [row], pool));
      expect(pool.removeAndPrune).toHaveBeenCalledOnce();
      expect(pool.removeAndPrune).toHaveBeenCalledWith(REPO_ROOT, row.worktree_path);
    });

    // -----------------------------------------------------------------------
    // Safety fence 1: running / starting sessions
    // -----------------------------------------------------------------------

    it('never removes a running session (fence 1)', async () => {
      const pool = makePool();
      await applyTeardownPolicy(
        makeArgs(policy, [session({ status: 'running', decision: 'failed' })], pool),
      );
      expect(pool.removeAndPrune).not.toHaveBeenCalled();
    });

    it('never removes a starting session (fence 1)', async () => {
      const pool = makePool();
      await applyTeardownPolicy(
        makeArgs(policy, [session({ status: 'starting', decision: 'failed' })], pool),
      );
      expect(pool.removeAndPrune).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Safety fence 2: exit_code = -1 (crash-eligible)
    // -----------------------------------------------------------------------

    it('never removes an exit_code=-1 session (fence 2 — crash recovery)', async () => {
      const pool = makePool();
      await applyTeardownPolicy(
        makeArgs(
          policy,
          [session({ exit_code: -1, status: 'exited', decision: 'failed' })],
          pool,
        ),
      );
      expect(pool.removeAndPrune).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Safety fence 3: unknown / passed decision
    // -----------------------------------------------------------------------

    it('keeps sessions with decision=null (unknown → keep)', async () => {
      const pool = makePool();
      await applyTeardownPolicy(
        makeArgs(policy, [session({ decision: null })], pool),
      );
      expect(pool.removeAndPrune).not.toHaveBeenCalled();
    });

    it('keeps sessions with decision=passed', async () => {
      const pool = makePool();
      await applyTeardownPolicy(
        makeArgs(policy, [session({ decision: 'passed' })], pool),
      );
      expect(pool.removeAndPrune).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // null worktree_path
    // -----------------------------------------------------------------------

    it('skips sessions with no worktree_path', async () => {
      const pool = makePool();
      await applyTeardownPolicy(
        makeArgs(policy, [session({ worktree_path: null })], pool),
      );
      expect(pool.removeAndPrune).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Mixed pool — only failed sessions are removed
    // -----------------------------------------------------------------------

    it('removes only failed sessions in a mixed pool', async () => {
      const pool = makePool();
      const rows: CandidateRow[] = [
        session({ session_id: 'sess-pass', worktree_path: '/wt/pass', decision: 'passed' }),
        session({ session_id: 'sess-fail', worktree_path: '/wt/fail', decision: 'failed' }),
        session({ session_id: 'sess-unk', worktree_path: '/wt/unk', decision: null }),
        session({ session_id: 'sess-crash', worktree_path: '/wt/crash', exit_code: -1, decision: 'failed' }),
        session({ session_id: 'sess-run', worktree_path: '/wt/run', status: 'running', decision: 'failed' }),
      ];
      await applyTeardownPolicy(makeArgs(policy, rows, pool));
      expect(pool.removeAndPrune).toHaveBeenCalledOnce();
      expect(pool.removeAndPrune).toHaveBeenCalledWith(REPO_ROOT, '/wt/fail');
    });

    // -----------------------------------------------------------------------
    // Best-effort: one removeAndPrune failure doesn't abort the rest
    // -----------------------------------------------------------------------

    it('continues processing after a removeAndPrune failure', async () => {
      const pool = makePool();
      pool.removeAndPrune
        .mockRejectedValueOnce(new Error('git worktree remove failed'))
        .mockResolvedValueOnce(undefined);
      const rows: CandidateRow[] = [
        session({ session_id: 'sess-a', worktree_path: '/wt/a', decision: 'failed' }),
        session({ session_id: 'sess-b', worktree_path: '/wt/b', decision: 'failed' }),
      ];
      // Should not throw
      await expect(applyTeardownPolicy(makeArgs(policy, rows, pool))).resolves.toBeUndefined();
      expect(pool.removeAndPrune).toHaveBeenCalledTimes(2);
    });
  },
);

// ---------------------------------------------------------------------------
// DB query failure → no-op (never throws)
// ---------------------------------------------------------------------------

describe('applyTeardownPolicy — DB errors', () => {
  it('never throws if the DB query fails', async () => {
    const pool = makePool();
    const brokenDb = {
      prepare: (sql: string) => ({
        get: () => ({ value: 'destroy-failing' }),
        all: () => {
          if (sql.includes('swarm_agents')) throw new Error('DB closed');
          return [];
        },
      }),
    } as unknown as ReturnType<typeof import('../db/client').getRawDb>;
    await expect(
      applyTeardownPolicy({
        swarmId: SWARM_ID,
        workspaceId: WS_ID,
        repoRoot: REPO_ROOT,
        rawDb: brokenDb,
        worktreePool: pool,
      }),
    ).resolves.toBeUndefined();
    expect(pool.removeAndPrune).not.toHaveBeenCalled();
  });
});
