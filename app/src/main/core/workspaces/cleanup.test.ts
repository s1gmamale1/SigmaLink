// SF-13 — Operator cleanup actions (main-process side).
//
// Tests for `cleanup.ts`. Uses a MockDb (never `new Database()` — better-sqlite3
// is built for Electron's ABI and cannot load in vitest). Assert row targeting +
// dir targeting; verify the live-session safety fence.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock fs/promises — never touch the real filesystem.
// ---------------------------------------------------------------------------

const readdirMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const rmMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('node:fs', () => ({
  promises: {
    readdir: (p: unknown, ...rest: unknown[]) => readdirMock(p, ...rest),
    rm: (p: unknown, opts: unknown) => rmMock(p, opts),
  },
  // existsSync used by removeWorkspace
  existsSync: vi.fn(() => false),
}));

// pruneRepoDir reads with { withFileTypes: true } — mocks return Dirent-ish objects.
function dirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir };
}
const dirents = (...names: string[]) => names.map((n) => dirent(n));

// ---------------------------------------------------------------------------
// Minimal MockDb — satisfies the better-sqlite3 interface subset we use.
// NEVER use `new Database()`.
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  workspace_id: string;
  worktree_path: string | null;
  status: string;
  exit_code: number | null;
  exited_at: number | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  repo_root: string | null;
}

/**
 * The cleanup module calls `db.prepare(sql).all(...)` and
 * `db.prepare(sql).get(...)` and `db.prepare(sql).run(...)`.
 * We need to handle the specific SQL patterns used in cleanup.ts.
 */
function makeDb(
  sessions: SessionRow[],
  workspaceRows: WorkspaceRow[] = [],
) {
  // Track mutations so tests can assert
  const deletedSessionIds: string[] = [];
  const deletedWorkspaceIds: string[] = [];

  const db = {
    _deletedSessionIds: deletedSessionIds,
    _deletedWorkspaceIds: deletedWorkspaceIds,

    prepare(sql: string) {
      const s = sql.trim().toLowerCase();

      // Shared keep-fence fetch (worktree-cleanup.listWorktreeSessionRows):
      // SELECT id, workspace_id, status, exit_code, exited_at, worktree_path
      // FROM agent_sessions WHERE worktree_path IS NOT NULL
      // Matched on the distinctive select list — NOT on 'worktree_path is not
      // null', which would also match the old liveWorktreePaths fence SQL
      // that removeWorkspaceAndGc still issues until Task 5.
      if (s.includes('select id, workspace_id, status, exit_code, exited_at, worktree_path')) {
        return {
          all() {
            return sessions
              .filter((r) => r.worktree_path !== null)
              .map((r) => ({
                id: r.id,
                workspace_id: r.workspace_id,
                status: r.status,
                exit_code: r.exit_code,
                exited_at: r.exited_at,
                worktree_path: r.worktree_path,
              }));
          },
        };
      }

      // SELECT live worktree paths (live = starting|running)
      if (s.includes('select distinct worktree_path') && s.includes("status in ('starting','running')")) {
        return {
          all(workspaceId: string) {
            return sessions
              .filter(
                (r) =>
                  r.workspace_id === workspaceId &&
                  r.worktree_path !== null &&
                  (r.status === 'starting' || r.status === 'running'),
              )
              .map((r) => ({ worktree_path: r.worktree_path! }));
          },
        };
      }

      // SELECT all sessions for workspace (list pane sessions to clear)
      if (
        s.includes('select') &&
        s.includes('from agent_sessions') &&
        s.includes('where workspace_id') &&
        s.includes('id')
      ) {
        return {
          all(workspaceId: string) {
            return sessions
              .filter((r) => r.workspace_id === workspaceId)
              .map((r) => ({ id: r.id, status: r.status }));
          },
        };
      }

      // SELECT workspace row by id
      if (s.includes('select') && s.includes('from workspaces') && s.includes('where id')) {
        return {
          get(id: string) {
            return workspaceRows.find((w) => w.id === id) ?? undefined;
          },
        };
      }

      // SELECT DISTINCT worktree_path for ALL workspace cleanup (dry-run / prune-orphan)
      // Used for: list all worktree dirs + any live sessions per workspace
      if (
        s.includes('select distinct worktree_path') &&
        !s.includes("status in ('starting','running')")
      ) {
        return {
          all() {
            return sessions
              .filter((r) => r.worktree_path !== null)
              .map((r) => ({ worktree_path: r.worktree_path! }));
          },
        };
      }

      // DELETE agent_sessions for a workspace
      if (s.includes('delete from agent_sessions') && s.includes('where workspace_id')) {
        return {
          run(workspaceId: string) {
            const ids = sessions
              .filter((r) => {
                if (r.workspace_id !== workspaceId) return false;
                if (s.includes("status not in ('starting','running')")) {
                  return r.status !== 'starting' && r.status !== 'running';
                }
                return true;
              })
              .map((r) => r.id);
            deletedSessionIds.push(...ids);
            // Remove from in-memory array
            const toRemove = new Set(ids);
            sessions.splice(
              0,
              sessions.length,
              ...sessions.filter((r) => !toRemove.has(r.id)),
            );
          },
        };
      }

      // DELETE from workspaces
      if (s.includes('delete from workspaces') && s.includes('where id')) {
        return {
          run(id: string) {
            deletedWorkspaceIds.push(id);
            const idx = workspaceRows.findIndex((w) => w.id === id);
            if (idx >= 0) workspaceRows.splice(idx, 1);
          },
        };
      }

      // UPDATE agent_sessions (clear/reset a session's status)
      if (s.includes('update agent_sessions') && s.includes('set')) {
        return {
          run() {
            // no-op in test
          },
        };
      }

      throw new Error(`[MockDb] Unhandled SQL in test:\n  ${sql}`);
    },
  };
  return db as unknown as import('better-sqlite3').Database & {
    _deletedSessionIds: string[];
    _deletedWorkspaceIds: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKTREE_BASE = '/userData/worktrees';
const WS_ID = 'ws-001';
const REPO_HASH = 'deadbeef1234';
const REPO_DIR = path.join(WORKTREE_BASE, REPO_HASH);

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: `sess-${Math.random().toString(36).slice(2)}`,
    workspace_id: WS_ID,
    worktree_path: path.join(REPO_DIR, `pane-${Math.random().toString(36).slice(2)}`),
    status: 'exited',
    exit_code: 0,
    exited_at: Date.now() - 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

let cleanupModule: typeof import('./cleanup');

beforeEach(async () => {
  vi.resetModules();
  cleanupModule = await import('./cleanup');
  rmMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// pruneOrphanWorktreesForWorkspace — dry-run tests
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktreesForWorkspace — dry-run', () => {
  it('returns all dirs when none are referenced by live sessions', async () => {
    const exitedSession = makeSession({ worktree_path: null });
    const db = makeDb([exitedSession]);

    readdirMock.mockResolvedValue(dirents('pane-a', 'pane-b'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: true,
    });

    expect(result.wouldRemove).toHaveLength(2);
    expect(result.liveBlocked).toHaveLength(0);
    expect(result.removed).toBe(0);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('excludes dirs whose path is live (starting or running)', async () => {
    const liveWorktree = path.join(REPO_DIR, 'live-pane');
    const liveSession = makeSession({
      worktree_path: liveWorktree,
      status: 'running',
    });
    const db = makeDb([liveSession]);

    readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: true,
    });

    expect(result.wouldRemove.map((p) => path.basename(p))).toEqual(['orphan-pane']);
    expect(result.liveBlocked.map((p) => path.basename(p))).toEqual(['live-pane']);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('win32: excludes live dirs when path case and separators differ', async () => {
    const worktreeBase = 'C:\\Users\\Me\\AppData\\Roaming\\SigmaLink\\worktrees';
    const repoHash = 'abc123def456';
    const liveSession = makeSession({
      worktree_path: 'c:/users/me/appdata/roaming/sigmalink/worktrees/ABC123DEF456/live-pane',
      status: 'running',
    });
    const db = makeDb([liveSession]);

    readdirMock.mockResolvedValue(dirents('Live-Pane', 'orphan-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase,
      repoHash,
      workspaceId: WS_ID,
      db,
      dryRun: true,
    });

    expect(result.wouldRemove.map((p) => path.win32.basename(p))).toEqual(['orphan-pane']);
    expect(result.liveBlocked.map((p) => path.win32.basename(p).toLowerCase())).toEqual(['live-pane']);
  });

  it('returns empty when worktree dir does not exist', async () => {
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const db = makeDb([]);

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: true,
    });

    expect(result.wouldRemove).toHaveLength(0);
    expect(result.removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanWorktreesForWorkspace — live (dryRun:false)
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktreesForWorkspace — live', () => {
  it('removes orphan dirs and returns counts', async () => {
    const orphanWorktree = path.join(REPO_DIR, 'orphan');
    const liveWorktree = path.join(REPO_DIR, 'live');
    const liveSession = makeSession({ worktree_path: liveWorktree, status: 'running' });
    const db = makeDb([liveSession]);

    readdirMock.mockResolvedValue(dirents('orphan', 'live'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.removed).toBe(1);
    expect(result.liveBlocked).toContain(liveWorktree);
    expect(rmMock).toHaveBeenCalledWith(orphanWorktree, { recursive: true, force: true });
  });

  it('does NOT remove dirs referenced by starting sessions', async () => {
    const startingWorktree = path.join(REPO_DIR, 'starting-pane');
    const startingSession = makeSession({
      worktree_path: startingWorktree,
      status: 'starting',
    });
    const db = makeDb([startingSession]);
    readdirMock.mockResolvedValue(dirents('starting-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.removed).toBe(0);
    expect(result.liveBlocked).toContain(startingWorktree);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('counts removal errors and does not throw (fail-open)', async () => {
    rmMock.mockRejectedValue(new Error('EACCES: permission denied'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = makeDb([
      // One exited session to bypass cold-install guard in the underlying
      // orphan cleanup — but the cleanup.ts module uses its own live-session
      // query, so just provide an empty sessions list here; the rm will still
      // be attempted.
      makeSession({ worktree_path: null, status: 'exited' }),
    ]);

    readdirMock.mockResolvedValue(dirents('bad-perm-dir'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.errors).toBe(1);
    expect(result.removed).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('never rm-rfs a stray FILE in the repoHash dir — dirs only (2026-06-10 audit, finding 3)', async () => {
    const db = makeDb([]);
    readdirMock.mockResolvedValue([dirent('stray-file.txt', false), dirent('orphan-dir', true)]);

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.removed).toBe(1);
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(
      path.join(REPO_DIR, 'orphan-dir'),
      { recursive: true, force: true },
    );
    expect(rmMock).not.toHaveBeenCalledWith(
      path.join(REPO_DIR, 'stray-file.txt'),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2026-06-10 audit, finding 1 (CRIT): keep ⊇ use fence.
// The prune fence must spare (a) resume/respawn-eligible exited/-1 worktrees
// and (b) sibling workspaces' worktrees in the SHARED <repoHash> dir
// (repoHash = sha1(repoRoot) — shared by all workspaces on one repo since
// migration 0034).
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktreesForWorkspace — keep ⊇ use fence', () => {
  it('spares a worktree owned by an exited/-1 (resume-eligible) session, even outside the 7-day window', async () => {
    const crashedPath = path.join(REPO_DIR, 'crashed-pane');
    const crashed = makeSession({
      worktree_path: crashedPath,
      status: 'exited',
      exit_code: -1,
      exited_at: Date.now() - 30 * 86400 * 1000, // 30 days — far outside the 7-day window
    });
    const db = makeDb([crashed]);
    readdirMock.mockResolvedValue(dirents('crashed-pane', 'orphan-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.liveBlocked.map((p) => path.basename(p))).toEqual(['crashed-pane']);
    expect(result.removed).toBe(1); // only orphan-pane
    expect(rmMock).not.toHaveBeenCalledWith(crashedPath, expect.anything());
  });

  it("spares ANOTHER workspace's running worktree in the shared repoHash dir", async () => {
    const siblingPath = path.join(REPO_DIR, 'sibling-live-pane');
    const sibling = makeSession({
      workspace_id: 'ws-OTHER',
      worktree_path: siblingPath,
      status: 'running',
      exited_at: null,
    });
    const db = makeDb([sibling]);
    readdirMock.mockResolvedValue(dirents('sibling-live-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID, // pruning on behalf of ws-001 must NOT stomp ws-OTHER
      db,
      dryRun: false,
    });

    expect(result.removed).toBe(0);
    expect(result.liveBlocked).toEqual([siblingPath]);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('spares a recently-exited (within 7 days) worktree — uncommitted-work guard', async () => {
    const recentPath = path.join(REPO_DIR, 'recent-pane');
    const recent = makeSession({
      worktree_path: recentPath,
      status: 'exited',
      exit_code: 0,
      exited_at: Date.now() - 1000,
    });
    const db = makeDb([recent]);
    readdirMock.mockResolvedValue(dirents('recent-pane', 'orphan-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.liveBlocked).toEqual([recentPath]);
    expect(result.removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// clearPanesForWorkspace
// ---------------------------------------------------------------------------

describe('clearPanesForWorkspace', () => {
  it('dry-run returns all session ids for the workspace', async () => {
    const s1 = makeSession({ id: 'sess-1', status: 'exited' });
    const s2 = makeSession({ id: 'sess-2', status: 'error' });
    const db = makeDb([s1, s2]);

    const result = await cleanupModule.clearPanesForWorkspace({
      workspaceId: WS_ID,
      db,
      dryRun: true,
    });

    expect(result.sessionIds).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
    expect(result.liveBlockedSessionIds).toEqual([]);
    expect(result.deleted).toBe(0);
    expect(db._deletedSessionIds).toHaveLength(0);
  });

  it('live-run deletes all sessions and returns count', async () => {
    const s1 = makeSession({ id: 'sess-1', status: 'exited' });
    const s2 = makeSession({ id: 'sess-2', status: 'exited' });
    const db = makeDb([s1, s2]);

    const result = await cleanupModule.clearPanesForWorkspace({
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.deleted).toBe(2);
    expect(db._deletedSessionIds).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
  });

  it('live-run preserves starting/running sessions and reports them as blocked', async () => {
    const exited = makeSession({ id: 'sess-exited', status: 'exited' });
    const running = makeSession({ id: 'sess-running', status: 'running' });
    const starting = makeSession({ id: 'sess-starting', status: 'starting' });
    const db = makeDb([exited, running, starting]);

    const result = await cleanupModule.clearPanesForWorkspace({
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.sessionIds).toEqual(['sess-exited']);
    expect(result.liveBlockedSessionIds.sort()).toEqual(['sess-running', 'sess-starting'].sort());
    expect(result.deleted).toBe(1);
    expect(db._deletedSessionIds).toEqual(['sess-exited']);
  });

  it('live-run with no sessions returns deleted=0', async () => {
    const db = makeDb([]);

    const result = await cleanupModule.clearPanesForWorkspace({
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// removeWorkspaceAndGc — the hard workspace cleanup
// ---------------------------------------------------------------------------

describe('removeWorkspaceAndGc', () => {
  it('dry-run: reports sessions + worktree dirs but mutates nothing', async () => {
    const liveWorktree = path.join(REPO_DIR, 'live-pane');
    const deadWorktree = path.join(REPO_DIR, 'orphan-pane');
    const liveSession = makeSession({ id: 'live-s', worktree_path: liveWorktree, status: 'running' });
    const exitedSession = makeSession({ id: 'dead-s', worktree_path: deadWorktree, status: 'exited' });
    const wsRow: WorkspaceRow = { id: WS_ID, name: 'test-ws', root_path: '/some/path', repo_root: '/some/path' };
    const db = makeDb([liveSession, exitedSession], [wsRow]);

    readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-pane'));

    const result = await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      db,
      dryRun: true,
    });

    expect(result.sessionCount).toBe(1);
    expect(result.liveBlockedSessionIds).toEqual(['live-s']);
    expect(result.worktreeCount).toBeGreaterThanOrEqual(0);
    expect(db._deletedWorkspaceIds).toHaveLength(0);
    expect(db._deletedSessionIds).toHaveLength(0);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('live-run: deletes sessions + workspace row + orphan worktree dirs', async () => {
    const exitedWorktree = path.join(REPO_DIR, 'exited-pane');
    const exitedSession = makeSession({ id: 'sess-x', worktree_path: exitedWorktree, status: 'exited' });
    const wsRow: WorkspaceRow = { id: WS_ID, name: 'test-ws', root_path: '/some/path', repo_root: '/some/path' };
    const db = makeDb([exitedSession], [wsRow]);

    readdirMock.mockResolvedValue(dirents('exited-pane'));

    const result = await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      db,
      dryRun: false,
    });

    expect(result.sessionCount).toBe(1);
    expect(db._deletedSessionIds).toContain('sess-x');
    expect(db._deletedWorkspaceIds).toContain(WS_ID);
  });

  it('live-run: spares live sessions/worktrees and blocks workspace row deletion', async () => {
    const liveWorktree = path.join(REPO_DIR, 'live-pane');
    const liveSession = makeSession({ id: 'live-s', worktree_path: liveWorktree, status: 'running' });
    const wsRow: WorkspaceRow = { id: WS_ID, name: 'test-ws', root_path: '/some/path', repo_root: '/some/path' };
    const db = makeDb([liveSession], [wsRow]);

    readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-pane'));

    const result = await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      db,
      dryRun: false,
    });

    // The live pane's worktree should NOT be deleted
    expect(rmMock).not.toHaveBeenCalledWith(
      liveWorktree,
      expect.anything(),
    );
    // The orphan pane CAN be deleted
    expect(rmMock).toHaveBeenCalledWith(
      path.join(REPO_DIR, 'orphan-pane'),
      expect.anything(),
    );
    // The workspace row is preserved while a live PTY-backed session remains.
    expect(db._deletedWorkspaceIds).not.toContain(WS_ID);
    expect(db._deletedSessionIds).not.toContain('live-s');
    expect(result.liveBlockedSessionIds).toEqual(['live-s']);
    expect(result.liveBlockedWorktrees).toContain(liveWorktree);
  });

  it('works without repoRoot (plain workspace) — skips worktree cleanup gracefully', async () => {
    const noRepoWs: WorkspaceRow = { id: WS_ID, name: 'plain-ws', root_path: '/plain/path', repo_root: null };
    const session = makeSession({ id: 'plain-s', worktree_path: null, status: 'exited' });
    const db = makeDb([session], [noRepoWs]);

    const result = await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      db,
      dryRun: false,
    });

    expect(result.worktreeCount).toBe(0);
    expect(db._deletedWorkspaceIds).toContain(WS_ID);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('throws if workspace not found', async () => {
    const db = makeDb([]);

    await expect(
      cleanupModule.removeWorkspaceAndGc({
        workspaceId: 'nonexistent',
        worktreeBase: WORKTREE_BASE,
        db,
        dryRun: false,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
