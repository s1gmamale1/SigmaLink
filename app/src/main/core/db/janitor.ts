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

import type Database from 'better-sqlite3';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, getRawDb } from './client';
import { agentSessions, swarms as swarmsTable, workspaces as workspacesTable } from './schema';
import { worktreePruneRepo } from '../git/git-ops';

export interface JanitorReport {
  zombieSessionsMarked: number;
  reposPruned: number;
  zombieSwarmsMarked: number;
  /** session-persistence fix (2026-07-18) — stale open siblings soft-closed. */
  supersededRowsClosed: number;
}

const PRUNE_BUDGET_MS = 1_000;

/**
 * session-persistence fix (2026-07-18) — close (soft-delete) every open pane
 * row that is NOT its slot's rank-winner. Stale siblings accumulate from
 * relaunch leaks and historical crashes; boot auto-resume used to respawn ALL
 * of them (old-conversation resurrection: the resurrected old row flipped
 * 'running' and out-ranked the operator's actual-latest row in
 * listForWorkspace). The rank mirrors panes.lastResumePlan / listForWorkspace
 * / listEligibleRows: live-first → started_at DESC → id DESC per
 * (workspace_id, pane_index); ranking runs over ALL rows (open + closed) so a
 * closed winner keeps its slot dark (rank-then-filter, PR #221). Runs every
 * boot; the first run heals the accumulated backlog. Legacy pane_index-NULL
 * rows are untouched.
 */
export function closeSupersededPaneRows(
  raw: Pick<Database.Database, 'prepare'>,
  now: number,
): number {
  try {
    const res = raw
      .prepare(
        `UPDATE agent_sessions
         SET closed_at = ?
         WHERE closed_at IS NULL
           AND pane_index IS NOT NULL
           AND id NOT IN (
             SELECT id FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY workspace_id, pane_index
                        ORDER BY
                          CASE WHEN status IN ('running', 'starting') THEN 0 ELSE 1 END ASC,
                          started_at DESC,
                          id DESC
                      ) AS rn
               FROM agent_sessions
               WHERE pane_index IS NOT NULL
             )
             WHERE rn = 1
           )`,
      )
      .run(now);
    return Number(res.changes ?? 0);
  } catch {
    /* best-effort — a sweep failure must never block boot */
    return 0;
  }
}

export async function runBootJanitor(): Promise<JanitorReport> {
  const db = getDb();
  const now = Date.now();

  // 1) Mark zombie running sessions as exited with a synthetic exit code. The
  //    UI uses exit_code=-1 to render "session exited unexpectedly" without
  //    breaking the existing status-based workflows.
  const running = db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.status, ['running', 'starting']))
    .all();
  let marked = 0;
  for (const row of running) {
    db.update(agentSessions)
      .set({ status: 'exited', exitCode: -1, exitedAt: now })
      .where(
        and(
          eq(agentSessions.id, row.id),
          inArray(agentSessions.status, ['running', 'starting']),
        ),
      )
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

  // 3) Mark zombie running swarms as failed. Any swarm row stuck in
  //    status='running' before the previous quit must be re-marked since the
  //    PTY agents that powered it are long gone.
  let zombieSwarmsMarked = 0;
  const runningSwarms = db
    .select()
    .from(swarmsTable)
    .where(eq(swarmsTable.status, 'running'))
    .all();
  for (const row of runningSwarms) {
    db.update(swarmsTable)
      .set({ status: 'failed', endedAt: now })
      .where(and(eq(swarmsTable.id, row.id), eq(swarmsTable.status, 'running')))
      .run();
    zombieSwarmsMarked += 1;
  }

  // 4) Close superseded pane rows AFTER the zombie flips so the rank sees the
  //    post-heal statuses (deterministic started_at ordering among non-live).
  const supersededRowsClosed = closeSupersededPaneRows(getRawDb(), now);

  return { zombieSessionsMarked: marked, reposPruned, zombieSwarmsMarked, supersededRowsClosed };
}
