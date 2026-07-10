// P1b Task 2 — deterministic pane→task watcher. Zero model calls: rides the
// existing pane-event sinks (PtyRegistry's `PaneEventSink` + rpc-router's
// shell-first `onCliExited`) and mechanically drives the mission-task state
// machine (`../missions/state`). When a mission-linked pane finishes, marks
// the task `reviewing` and enqueues a review wake for the (Task 3, DI'd)
// scheduler — no assistant/model path anywhere in this file.
//
// `PaneLikeEvent.kind` deliberately does NOT import `PaneEventSink` from
// `../pty/registry`: that enum has no `'cli-exited'` member (the SQLite pane-
// events enum doesn't either — `onCliExited` is a separate sink wired in
// rpc-router). This module accepts both real sink shapes under one type.

import * as missionsDao from '../missions/dao';

export type PaneLikeEvent = {
  sessionId: string;
  kind: 'started' | 'exited' | 'error' | 'idle' | 'cli-exited';
  exitCode?: number;
};

export type WakeEnqueue = (kind: 'review', missionId: string, taskId: string) => void;

export interface MissionWatcherDeps {
  enqueue: WakeEnqueue;
  isEnabled: () => boolean;
}

export interface MissionWatcher {
  onPaneEvent(event: PaneLikeEvent): void;
}

const TERMINAL_KINDS = new Set<PaneLikeEvent['kind']>(['exited', 'cli-exited', 'error', 'idle']);

export function createMissionWatcher(deps: MissionWatcherDeps): MissionWatcher {
  const { enqueue, isEnabled } = deps;

  function onPaneEvent(event: PaneLikeEvent): void {
    if (!isEnabled()) return;
    const tasks = missionsDao.listTasksForSession(event.sessionId);
    if (tasks.length === 0) return; // not a mission pane

    for (const task of tasks) {
      if (event.kind === 'started') {
        try {
          missionsDao.moveTask(task.id, 'working');
        } catch {
          // a racing/illegal transition must never throw out of a pane-event sink
        }
        continue;
      }

      if (!TERMINAL_KINDS.has(event.kind)) continue;

      // Idempotency: only a task still working/dispatched can be moved to
      // reviewing. Re-reading the pre-move status here (fresh per event) is
      // what stops a second terminal event on an already-reviewing task from
      // re-appending the event or re-enqueuing the wake.
      if (task.status !== 'working' && task.status !== 'dispatched') continue;

      // In the real dispatch flow PtyRegistry.spawn fires the 'started' event
      // SYNCHRONOUSLY, before dispatch_task's linkTaskToPane runs — so the
      // task↔session link doesn't exist yet and the started→working move
      // above is a guaranteed miss. The task is therefore still `dispatched`,
      // not `working`, when the terminal event arrives; `dispatched →
      // reviewing` is illegal, so chain through `working` first. One
      // try/catch covers the whole sequence (including appendEvent/enqueue)
      // so nothing — a DB throw, a throwing DI'd enqueue — escapes the sink.
      try {
        if (task.status === 'dispatched') missionsDao.moveTask(task.id, 'working');
        missionsDao.moveTask(task.id, 'reviewing');
        missionsDao.appendEvent(task.missionId, task.id, 'task_awaiting_review');
        enqueue('review', task.missionId, task.id);
      } catch {
        continue; // racing/illegal transition, or a throwing dep — swallow it
      }
    }
  }

  return { onPaneEvent };
}
