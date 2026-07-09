// P1b Task 4 — the supervisor wake runner: the model-in-the-loop half of
// mission autonomy. Task 3's scheduler calls `runWake(wake)` once its four
// hard gates clear; this module frames the wake as an `assistant.send` turn
// (DI'd as `runTurn`, origin:'autonomous') carrying a directive built by
// `./directive`, so the brain decomposes a mission or reviews a finished
// task's pane output and drives the board forward itself via the mission
// tools (`move_mission_task` / `dispatch_task` / `complete_mission`). This
// module never touches those tools directly — it only starts the turn; the
// brain's own tool calls do the actual board mutation.
//
// MAX_ATTEMPTS is the hard stop against an infinite review → re-dispatch
// loop draining the operator's Claude sub: a review wake for a task at or
// past the cap moves it straight to `blocked` and returns — NO model call,
// no budget spent. This is the one safety property Task 3's four gates
// cannot see (they gate WHEN a wake may run at all, not whether a specific
// task has already burned its retries), so it lives here instead.
//
// Mission ↔ conversation link: P1a's `missions` table has no
// `conversationId` column (checked `../db/schema.ts` — a mission board
// entity is deliberately model-agnostic) and adding one is a migration,
// outside this task's file scope. Per the brief's decision policy this
// module keeps its own in-memory `missionId → conversationId` map (repo
// convention — DAOs are imported directly, not DI'd; see `watch.ts`'s header
// comment) and creates a dedicated `kind:'assistant'` conversation on the
// FIRST wake for a given mission, reusing it for every wake after. A mission
// with no `workspaceId` (autonomous/telegram-origin missions are frequently
// workspace-less) falls back to a sentinel global id — `conversations.
// workspace_id` is NOT NULL but carries no foreign key (checked migration
// `0006_assistant.ts`), so a sentinel string is a safe, real row.
//
// P2 Task 5 (D1) — the in-memory map above is restart-lossy: every app
// relaunch forgot every mission's conversation, silently starting a FRESH
// one and stranding prior turns' history. `ensureMissionConversation` now
// checks a KV-durable pointer (`KV_MISSION_CONVERSATION_PREFIX + missionId`,
// imported from `./global`) before minting a new conversation: in-memory
// map hit → use it (same-process fast path); else a KV hit whose
// conversation ROW STILL EXISTS → adopt + cache it (restart recovery); else
// create fresh + persist the new pointer (first wake, or the pinned
// conversation was deleted out from under it). `kvGet`/`kvSet` are REQUIRED
// SupervisorDeps (not optional) — rpc-router.ts always has `controlKv`
// in scope at the createSupervisor call site, so there is no legitimate
// caller without a KV backing.

import * as missionsDao from '../missions/dao';
import { createConversation, getConversation } from '../assistant/conversations';
import { buildDecomposeDirective, buildReviewDirective } from './directive';
import { MAX_ATTEMPTS } from '../missions/state';
import { JORVIS_GLOBAL_WORKSPACE_ID, KV_MISSION_CONVERSATION_PREFIX } from './global';
import type { Wake } from './scheduler';
import type { Mission } from '../../../shared/types';

export { MAX_ATTEMPTS };

export interface SupervisorDeps {
  /** DI'd `assistant.send` — the ONLY way this module wakes the model. No CLI spawn, no other model path. */
  runTurn: (input: {
    conversationId: string;
    prompt: string;
    origin: 'autonomous';
  }) => Promise<{ turnId: string }>;
  /** Reads a pane's recent output for the review directive's excerpt (capped by directive.ts). */
  readPane: (sessionId: string) => string;
  /** KV-durable mission→conversation pinning (P2 T5, D1). Raw read; null if absent/on error. */
  kvGet: (key: string) => string | null;
  /** KV-durable mission→conversation pinning (P2 T5, D1). Best-effort write. */
  kvSet: (key: string, value: string) => void;
}

export interface Supervisor {
  runWake(wake: Wake): Promise<void>;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { runTurn, readPane, kvGet, kvSet } = deps;
  const conversationByMission = new Map<string, string>();

  function ensureMissionConversation(mission: Mission): string {
    const existing = conversationByMission.get(mission.id);
    if (existing) return existing;

    const kvKey = `${KV_MISSION_CONVERSATION_PREFIX}${mission.id}`;
    const pinned = kvGet(kvKey);
    if (pinned && getConversation(pinned)) {
      conversationByMission.set(mission.id, pinned);
      return pinned;
    }

    const conversation = createConversation({
      workspaceId: mission.workspaceId ?? JORVIS_GLOBAL_WORKSPACE_ID,
      kind: 'assistant',
    });
    kvSet(kvKey, conversation.id);
    conversationByMission.set(mission.id, conversation.id);
    return conversation.id;
  }

  async function runDecompose(wake: Wake): Promise<void> {
    const mission = missionsDao.getMission(wake.missionId);
    if (!mission) return; // deleted/racing mission — nothing to decompose
    const conversationId = ensureMissionConversation(mission);
    const prompt = buildDecomposeDirective(mission);
    await runTurn({ conversationId, prompt, origin: 'autonomous' });
  }

  async function runReview(wake: Wake): Promise<void> {
    if (!wake.taskId) return; // malformed wake — nothing to review
    const task = missionsDao.getTask(wake.taskId);
    if (!task) return; // deleted/racing task — nothing to review

    if (task.attempt >= MAX_ATTEMPTS) {
      // The runaway stop. Escalate to a human instead of letting the brain
      // re-dispatch the same task forever — spend zero model budget doing it.
      missionsDao.moveTask(task.id, 'blocked');
      missionsDao.appendEvent(
        task.missionId,
        task.id,
        'task_max_attempts',
        JSON.stringify({ attempt: task.attempt, maxAttempts: MAX_ATTEMPTS }),
      );
      return;
    }

    const mission = missionsDao.getMission(task.missionId);
    if (!mission) return; // deleted/racing mission — nothing to review into
    const conversationId = ensureMissionConversation(mission);
    const paneExcerpt = task.assigneeSessionId ? readPane(task.assigneeSessionId) : '';
    const prompt = buildReviewDirective(mission, task, paneExcerpt);
    await runTurn({ conversationId, prompt, origin: 'autonomous' });
  }

  async function runWake(wake: Wake): Promise<void> {
    if (wake.kind === 'decompose') {
      await runDecompose(wake);
    } else {
      await runReview(wake);
    }
  }

  return { runWake };
}
