// Boot-time database janitor.
//
// On app start we may find rows in `agent_sessions` left over from a previous
// run (status='running' but the PTY is long gone — the process either crashed
// or the user force-quit). The janitor sweeps those rows so the UI never
// shows a "running" pane that is actually dead, and the launcher's id pool
// stays clean.
//
// The janitor also runs `git worktree prune` once per repoRoot referenced by
// surviving worktree rows, but only if doing so completes within ~1s; we do
// not want to slow boot for users with very large worktree pools.

import { eq, and } from 'drizzle-orm';
import { getDb } from './client';
import { agentSessions, workspaces as workspacesTable } from './schema';
import { worktreePruneRepo } from '../git/git-ops';

export interface JanitorReport {
  zombieSessionsMarked: number;
  reposPruned: number;
}

const PRUNE_BUDGET_MS = 1_000;

export async function runBootJanitor(): Promise<JanitorReport> {
  const db = getDb();
  const now = Date.now();

  // 1) Mark zombie running sessions as exited with a synthetic exit code. The
  //    UI uses exit_code=-1 to render "session exited unexpectedly" without
  //    breaking the existing status-based workflows.
  const running = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.status, 'running'))
    .all();
  let marked = 0;
  for (const row of running) {
    db.update(agentSessions)
      .set({ status: 'exited', exitCode: -1, exitedAt: now })
      .where(and(eq(agentSessions.id, row.id), eq(agentSessions.status, 'running')))
      .run();
    marked += 1;
  }

  // 2) Best-effort `git worktree prune` per repo with surviving worktree rows.
  //    We collect distinct repo roots from the workspaces table because the
  //    worktrees referenced by sessions are children of those repos.
  let reposPruned = 0;
  const repoRoots = new Set<string>();
  for (const ws of db.select().from(workspacesTable).all()) {
    if (ws.repoMode === 'git' && ws.repoRoot) repoRoots.add(ws.repoRoot);
  }
  const start = Date.now();
  for (const root of repoRoots) {
    if (Date.now() - start > PRUNE_BUDGET_MS) break;
    try {
      await worktreePruneRepo(root);
      reposPruned += 1;
    } catch {
      /* best-effort */
    }
  }

  return { zombieSessionsMarked: marked, reposPruned };
}
