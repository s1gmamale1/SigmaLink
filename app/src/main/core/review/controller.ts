// Review-Room RPC controller. Maps `review.*` channels onto a thin layer over
// the diff/runner modules + DB. The controller is intentionally side-effect
// concentrated: every method either reads a snapshot or commits a single
// durable change.

import path from 'node:path';
import fs from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import type {
  AgentSession,
  ReviewConflict,
  ReviewDiff,
  ReviewSession,
  ReviewState,
  BatchCommitResult,
  ReviewDecision,
} from '../../../shared/types';
import { getDb } from '../db/client';
import { agentSessions, sessionReview, workspaces } from '../db/schema';
import {
  commitAndMerge,
  dropChanges,
  gitStatus,
  worktreePruneRepo,
} from '../git/git-ops';
import type { WorktreePool } from '../git/worktree';
import { computeReviewDiff, computeConflicts } from './diff';
import type { ReviewRunner } from './runner';

export interface ReviewControllerDeps {
  worktreePool: WorktreePool;
  runner: ReviewRunner;
  /**
   * Notify subscribers that a session's review state changed (decision,
   * notes, run completed, dropped, merged). Used by the renderer to refresh
   * the list rail.
   */
  onChanged: (sessionId: string) => void;
}

function getOrCreateReviewRow(sessionId: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(sessionReview)
    .where(eq(sessionReview.sessionId, sessionId))
    .get();
  if (existing) return existing;
  db.insert(sessionReview)
    .values({ sessionId, notes: '', updatedAt: Date.now() })
    .run();
  return db
    .select()
    .from(sessionReview)
    .where(eq(sessionReview.sessionId, sessionId))
    .get()!;
}

function inferBaseRef(repoRoot: string): string {
  // Pick a sensible base. Most Sigma workspaces are launched from `main` or
  // `master`; if neither exists we fall back to HEAD.
  const candidates = ['main', 'master', 'develop'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(repoRoot, '.git', 'refs', 'heads', c))) return c;
  }
  return 'HEAD';
}

function buildReviewSession(input: {
  session: typeof agentSessions.$inferSelect;
  reviewRow: typeof sessionReview.$inferSelect | null;
}): ReviewSession {
  const r = input.reviewRow;
  const s = input.session;
  return {
    sessionId: s.id,
    workspaceId: s.workspaceId,
    providerId: s.providerId,
    branch: s.branch,
    worktreePath: s.worktreePath,
    cwd: s.cwd,
    status: s.status as AgentSession['status'],
    startedAt: s.startedAt,
    notes: r?.notes ?? '',
    decision: (r?.decision ?? null) as ReviewDecision,
    decidedAt: r?.decidedAt ?? null,
    lastTestCommand: r?.lastTestCommand ?? null,
    lastTestExitCode: r?.lastTestExitCode ?? null,
  };
}

export function buildReviewController(deps: ReviewControllerDeps) {
  return defineController({
    list: async (workspaceId: string): Promise<ReviewState> => {
      const db = getDb();
      const sessions = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.workspaceId, workspaceId))
        .all();
      const ids = sessions.map((s) => s.id);
      const reviewRows = ids.length
        ? db
            .select()
            .from(sessionReview)
            .where(inArray(sessionReview.sessionId, ids))
            .all()
        : [];
      const byId = new Map(reviewRows.map((r) => [r.sessionId, r]));

      const items: ReviewSession[] = [];
      for (const s of sessions) {
        if (!s.worktreePath) {
          items.push(buildReviewSession({ session: s, reviewRow: byId.get(s.id) ?? null }));
          continue;
        }
        let statusSummary = null;
        try {
          statusSummary = await gitStatus(s.worktreePath);
        } catch {
          /* ignore */
        }
        const base = buildReviewSession({ session: s, reviewRow: byId.get(s.id) ?? null });
        items.push({ ...base, gitStatus: statusSummary });
      }
      return { workspaceId, sessions: items };
    },

    getDiff: async (sessionId: string): Promise<ReviewDiff | null> => {
      const db = getDb();
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get();
      if (!row || !row.worktreePath) return null;
      const diff = await computeReviewDiff(row.worktreePath);
      if (diff && row.branch) {
        return { ...diff, branch: row.branch };
      }
      return diff;
    },

    getConflicts: async (sessionId: string): Promise<ReviewConflict[]> => {
      const db = getDb();
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get();
      if (!row || !row.worktreePath) return [];
      const ws = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, row.workspaceId))
        .get();
      if (!ws || !ws.repoRoot) return [];
      const base = inferBaseRef(ws.repoRoot);
      return computeConflicts({
        repoRoot: ws.repoRoot,
        worktreeBranch: row.branch,
        base,
      });
    },

    runCommand: async (input: {
      sessionId: string;
      command: string;
    }): Promise<{ runId: string }> => {
      const db = getDb();
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, input.sessionId))
        .get();
      if (!row || !row.worktreePath) {
        throw new Error('session has no worktree');
      }
      const runId = deps.runner.start({
        sessionId: input.sessionId,
        cwd: row.worktreePath,
        command: input.command,
      });
      return { runId };
    },

    killCommand: async (sessionId: string): Promise<void> => {
      deps.runner.kill(sessionId);
    },

    setNotes: async (input: { sessionId: string; notes: string }): Promise<void> => {
      const db = getDb();
      getOrCreateReviewRow(input.sessionId);
      db.update(sessionReview)
        .set({ notes: input.notes, updatedAt: Date.now() })
        .where(eq(sessionReview.sessionId, input.sessionId))
        .run();
      deps.onChanged(input.sessionId);
    },

    markPassed: async (sessionId: string): Promise<void> => {
      const db = getDb();
      getOrCreateReviewRow(sessionId);
      db.update(sessionReview)
        .set({ decision: 'passed', decidedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(sessionReview.sessionId, sessionId))
        .run();
      deps.onChanged(sessionId);
    },

    markFailed: async (sessionId: string): Promise<void> => {
      const db = getDb();
      getOrCreateReviewRow(sessionId);
      db.update(sessionReview)
        .set({ decision: 'failed', decidedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(sessionReview.sessionId, sessionId))
        .run();
      deps.onChanged(sessionId);
    },

    commitAndMerge: async (input: {
      sessionId: string;
      message: string;
    }): Promise<{ stdout: string; stderr: string; code: number }> => {
      const db = getDb();
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, input.sessionId))
        .get();
      if (!row || !row.worktreePath || !row.branch) {
        throw new Error('session has no branch/worktree');
      }
      const ws = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, row.workspaceId))
        .get();
      if (!ws || !ws.repoRoot) {
        throw new Error('workspace has no repo root');
      }
      const result = await commitAndMerge({
        worktreePath: row.worktreePath,
        branch: row.branch,
        repoRoot: ws.repoRoot,
        message: input.message,
      });
      if (result.code === 0) {
        // Successful merge: clean the worktree + branch.
        try {
          deps.runner.kill(input.sessionId);
          await deps.worktreePool.removeAndPrune(ws.repoRoot, row.worktreePath);
        } catch {
          /* best-effort */
        }
        try {
          const { execCmd } = await import('../../lib/exec');
          await execCmd('git', ['branch', '-D', row.branch], {
            cwd: ws.repoRoot,
            timeoutMs: 15_000,
          });
        } catch {
          /* best-effort */
        }
        // Clear worktree path on the session row so the UI knows it was merged.
        db.update(agentSessions)
          .set({ worktreePath: null })
          .where(eq(agentSessions.id, input.sessionId))
          .run();
        getOrCreateReviewRow(input.sessionId);
        db.update(sessionReview)
          .set({ decision: 'passed', decidedAt: Date.now(), updatedAt: Date.now() })
          .where(eq(sessionReview.sessionId, input.sessionId))
          .run();
      }
      deps.onChanged(input.sessionId);
      return result;
    },

    dropChanges: async (sessionId: string): Promise<{ code: number; stderr: string }> => {
      const db = getDb();
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get();
      if (!row || !row.worktreePath) throw new Error('session has no worktree');
      const r = await dropChanges(row.worktreePath);
      deps.onChanged(sessionId);
      return { code: r.code, stderr: r.stderr };
    },

    pruneOrphans: async (workspaceId: string): Promise<void> => {
      const db = getDb();
      const ws = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .get();
      if (!ws || !ws.repoRoot) return;
      await worktreePruneRepo(ws.repoRoot);
    },

    batchCommitAndMerge: async (input: {
      sessionIds: string[];
      messageTemplate: string;
    }): Promise<BatchCommitResult> => {
      const out: BatchCommitResult = { results: [] };
      for (const id of input.sessionIds) {
        try {
          const db = getDb();
          const row = db
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.id, id))
            .get();
          if (!row || !row.worktreePath || !row.branch) {
            out.results.push({
              sessionId: id,
              ok: false,
              code: -1,
              error: 'session has no branch/worktree',
            });
            continue;
          }
          const ws = db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, row.workspaceId))
            .get();
          if (!ws || !ws.repoRoot) {
            out.results.push({
              sessionId: id,
              ok: false,
              code: -1,
              error: 'workspace has no repo root',
            });
            continue;
          }
          const message = input.messageTemplate.replace('${branch}', row.branch);
          const r = await commitAndMerge({
            worktreePath: row.worktreePath,
            branch: row.branch,
            repoRoot: ws.repoRoot,
            message,
          });
          if (r.code === 0) {
            try {
              await deps.worktreePool.removeAndPrune(ws.repoRoot, row.worktreePath);
            } catch {
              /* best-effort */
            }
            try {
              const { execCmd } = await import('../../lib/exec');
              await execCmd('git', ['branch', '-D', row.branch], {
                cwd: ws.repoRoot,
                timeoutMs: 15_000,
              });
            } catch {
              /* best-effort */
            }
            db.update(agentSessions)
              .set({ worktreePath: null })
              .where(eq(agentSessions.id, id))
              .run();
            getOrCreateReviewRow(id);
            db.update(sessionReview)
              .set({
                decision: 'passed',
                decidedAt: Date.now(),
                updatedAt: Date.now(),
              })
              .where(eq(sessionReview.sessionId, id))
              .run();
          }
          deps.onChanged(id);
          out.results.push({
            sessionId: id,
            ok: r.code === 0,
            code: r.code,
            stderr: r.stderr,
          });
          if (r.code !== 0) break; // stop on first failure
        } catch (err) {
          out.results.push({
            sessionId: id,
            ok: false,
            code: -1,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
      }
      return out;
    },
  });
}
