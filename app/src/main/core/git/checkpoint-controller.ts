// P6 FEAT-11 — agent undo/rewind checkpoint controller.
//
// The git checkpoint methods are extracted here (rather than inlined in
// rpc-router.ts) for the same reason every other room has a `controller.ts`:
// the rpc-router module pulls in Electron + better-sqlite3 at import time and
// can't load under vitest, so the testable logic lives in this dependency-
// injected factory. rpc-router.ts builds it with the live deps and spreads the
// methods into `gitCtl`.
//
// Contract:
//   - The renderer NEVER supplies a filesystem path; every method takes a
//     sessionId and the controller resolves the worktree server-side from
//     agent_sessions (mirrors the review controller).
//   - createCheckpoint commits the WIP as a manual savepoint + records a row.
//   - restoreCheckpoint validates the sha belongs to THIS session's checkpoints
//     (ownership) — the git-ops layer additionally validates ancestry — then
//     records the auto pre-rewind safety snapshot returned by the destructive
//     op. The safety row is recorded even on reset failure (it's committed
//     before the reset), so the operator always has a way back.

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { agentSessions, sessionCheckpoints } from '../db/schema';
import type { getDb } from '../db/client';
import type { SessionCheckpoint } from '../../../shared/types';
import type { createCheckpoint as CreateCheckpointFn, restoreCheckpoint as RestoreCheckpointFn } from './git-ops';

// The drizzle DB handle the controller queries through. Typed off the live
// `getDb` return so production wiring stays end-to-end typed; a test passes a
// chainable fake cast through this signature (better-sqlite3 can't load under
// vitest).
export type CheckpointDb = ReturnType<typeof getDb>;

export interface CheckpointControllerDeps {
  getDb: () => CheckpointDb;
  createCheckpoint: typeof CreateCheckpointFn;
  restoreCheckpoint: typeof RestoreCheckpointFn;
  /** Broadcast `git:checkpoints-changed` so the rewind panel can refresh. */
  onChanged: (sessionId: string) => void;
}

export function buildGitCheckpointController(deps: CheckpointControllerDeps) {
  const resolveSessionWorktree = (sessionId: string): string | null => {
    const row = deps
      .getDb()
      .select({ worktreePath: agentSessions.worktreePath })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return row?.worktreePath ?? null;
  };

  return {
    createCheckpoint: async (input: {
      sessionId: string;
      label?: string;
    }): Promise<SessionCheckpoint> => {
      const worktreePath = resolveSessionWorktree(input.sessionId);
      if (!worktreePath) throw new Error('session has no worktree');
      const res = await deps.createCheckpoint(worktreePath, input.label);
      if (!res.ok || !res.sha) {
        throw new Error(res.error ?? 'checkpoint failed');
      }
      const row: SessionCheckpoint = {
        id: randomUUID(),
        sessionId: input.sessionId,
        sha: res.sha,
        label: input.label?.trim() || null,
        kind: 'manual',
        createdAt: Date.now(),
      };
      deps.getDb().insert(sessionCheckpoints).values(row).run();
      deps.onChanged(input.sessionId);
      return row;
    },

    listCheckpoints: async (sessionId: string): Promise<SessionCheckpoint[]> => {
      return deps
        .getDb()
        .select()
        .from(sessionCheckpoints)
        .where(eq(sessionCheckpoints.sessionId, sessionId))
        .orderBy(desc(sessionCheckpoints.createdAt))
        .all();
    },

    restoreCheckpoint: async (input: {
      sessionId: string;
      sha: string;
    }): Promise<{ ok: true; safetySha: string | null }> => {
      const worktreePath = resolveSessionWorktree(input.sessionId);
      if (!worktreePath) throw new Error('session has no worktree');
      // Ownership guard: the sha MUST be one of THIS session's recorded
      // checkpoints (the git-ops layer additionally enforces ancestry).
      const owned = deps
        .getDb()
        .select()
        .from(sessionCheckpoints)
        .where(
          and(
            eq(sessionCheckpoints.sessionId, input.sessionId),
            eq(sessionCheckpoints.sha, input.sha),
          ),
        )
        .get();
      if (!owned) throw new Error('checkpoint does not belong to this session');

      const res = await deps.restoreCheckpoint(worktreePath, input.sha);
      // The safety snapshot is committed BEFORE the reset, so record it even if
      // the reset itself failed — it's the operator's way back to "now".
      if (res.safetySha) {
        deps
          .getDb()
          .insert(sessionCheckpoints)
          .values({
            id: randomUUID(),
            sessionId: input.sessionId,
            sha: res.safetySha,
            label: 'pre-rewind',
            kind: 'auto',
            createdAt: Date.now(),
          })
          .run();
      }
      deps.onChanged(input.sessionId);
      if (!res.ok) throw new Error(res.error ?? 'restore failed');
      return { ok: true, safetySha: res.safetySha ?? null };
    },
  };
}
