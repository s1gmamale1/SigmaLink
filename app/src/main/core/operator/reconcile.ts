// Pre-v3 fix — the mission reconciler: the catch-up half of autonomy's
// liveness story. The scheduler's drain DISCARDS a gate-dropped wake (quiet
// hours / budget / freeze — see scheduler.ts) and the watcher is purely
// event-driven off LIVE pane events (watch.ts), so two whole classes of
// in-flight work strand silently:
//
//   1. A pane exits while a gate is closed (the 23:00 quiet-hours exit) —
//      the review wake is dropped and nothing ever re-fires it.
//   2. The app restarts — a `dispatched`/`working` task's CLI process died
//      with the previous process (dispatched CLIs are PTY children; they
//      NEVER survive a relaunch, even when the pane session itself resumes
//      as a fresh shell), so its terminal pane event will never arrive.
//
// sweep() re-derives the lost wakes from the durable board instead of the
// ephemeral event stream: reviewing → re-enqueue review (scheduler dedupes);
// dispatched/working with a dead pane → chain to reviewing (same path as
// watch.ts) + enqueue review; an active mission with no dispatchable
// progress at all (zero tasks, or all still backlog) → re-enqueue decompose
// (safe to repeat — buildDecomposeDirective lists existing tasks and forbids
// duplicating them). `blocked`/`needs_input` are waiting on a HUMAN and
// `done` is terminal — never touched.
//
// Two sweep modes, one difference: how "is this pane's work dead?" is
// answered. 'periodic' trusts the live registry (`isPaneLive`); 'boot' takes
// the structural truth above and treats every in-flight task as dead. Every
// wake this module enqueues still rides ALL four scheduler gates — a sweep
// during quiet hours enqueues wakes that are dropped again, and the next
// sweep retries; budget bounds the worst case (a review turn that never
// verdicts can be re-woken at most once per sweep until the daily cap).
//
// PURE + DI apart from the missions DAO (imported directly — repo
// convention, see watch.ts's header): `enqueue`, `isEnabled`, `isPaneLive`
// and `now` are injected so every branch is deterministically testable. A
// sweep must NEVER throw (it runs off a timer at app scope): the DAO scan is
// guarded, and each mission is swept inside its own try/catch so one broken
// mission/pane probe can't starve the rest.

import * as missionsDao from '../missions/dao';
import type { WakeKind } from './scheduler';
import type { Mission } from '../../../shared/types';

export type SweepMode = 'boot' | 'periodic';

export interface MissionReconcilerDeps {
  /** The scheduler's enqueue — every re-derived wake still rides the four gates. */
  enqueue: (kind: WakeKind, missionId: string, taskId?: string) => void;
  /** Same KV flag the watcher gates on (`missions.autonomy.enabled`). */
  isEnabled: () => boolean;
  /** Live pane-registry probe (PtyRegistry.isLive) — consulted in 'periodic' mode only. */
  isPaneLive: (sessionId: string) => boolean;
  /** Injected clock for the unlinked-task grace window. */
  now: () => number;
  /** Grace before an UNLINKED dispatched/working task counts as stranded in
   *  'periodic' mode — dispatch_task links the pane moments after the status
   *  move, so a young unlinked task is a mid-dispatch race, not a strand. */
  dispatchGraceMs?: number;
}

export interface MissionReconciler {
  sweep(mode: SweepMode): void;
}

const DEFAULT_DISPATCH_GRACE_MS = 10 * 60_000;

/** Periodic-sweep cadence for the wiring (rpc-router.ts). 10 minutes: fast
 *  enough that quiet-hours ending or a budget-day rollover resumes stranded
 *  work promptly, cheap enough that a disabled/idle install pays a few DB
 *  reads an hour at most. */
export const MISSION_SWEEP_INTERVAL_MS = 10 * 60_000;

export function createMissionReconciler(deps: MissionReconcilerDeps): MissionReconciler {
  const { enqueue, isEnabled, isPaneLive, now } = deps;
  const graceMs = deps.dispatchGraceMs ?? DEFAULT_DISPATCH_GRACE_MS;

  function sweepMission(mission: Mission, mode: SweepMode): void {
    const tasks = missionsDao.listTasks(mission.id);

    if (tasks.length === 0 || tasks.every((t) => t.status === 'backlog')) {
      enqueue('decompose', mission.id);
      return;
    }

    for (const task of tasks) {
      if (task.status === 'reviewing') {
        // The review wake itself was dropped — no board mutation needed, the
        // scheduler's queued/running dedupe absorbs a wake that's already
        // in flight.
        enqueue('review', mission.id, task.id);
        continue;
      }
      if (task.status !== 'dispatched' && task.status !== 'working') continue;

      const stranded =
        mode === 'boot'
          ? true
          : task.assigneeSessionId
            ? !isPaneLive(task.assigneeSessionId)
            : now() - task.updatedAt >= graceMs;
      if (!stranded) continue;

      // Same dispatched→working→reviewing chain (and the same swallow-all
      // guard) as watch.ts's terminal-event path — a racing/illegal
      // transition or a throwing dep must never take down the sweep.
      try {
        if (task.status === 'dispatched') missionsDao.moveTask(task.id, 'working');
        missionsDao.moveTask(task.id, 'reviewing');
        missionsDao.appendEvent(
          mission.id,
          task.id,
          'task_reconciled',
          JSON.stringify({ from: task.status, mode }),
        );
        enqueue('review', mission.id, task.id);
      } catch {
        continue;
      }
    }
  }

  function sweep(mode: SweepMode): void {
    try {
      if (!isEnabled()) return;
      for (const mission of missionsDao.listActiveMissions()) {
        try {
          sweepMission(mission, mode);
        } catch {
          // one broken mission must not starve the rest of the sweep
        }
      }
    } catch {
      // the sweep runs at app scope off a timer — it must never throw
    }
  }

  return { sweep };
}
