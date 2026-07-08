// Pure lifecycle state machine for the mission board. No I/O, no DB — every
// legal transition + the mission-status rollup lives here so the DAO and the
// (P1b) supervisor share ONE source of truth and it is exhaustively testable.

import type { MissionStatus, MissionTaskStatus } from '../../../shared/types';

const TASK_TRANSITIONS: Record<MissionTaskStatus, MissionTaskStatus[]> = {
  backlog: ['dispatched'],
  dispatched: ['working', 'blocked', 'needs_input'],
  working: ['reviewing', 'blocked', 'needs_input', 'done'],
  reviewing: ['working', 'done', 'blocked', 'needs_input'],
  needs_input: ['working', 'dispatched', 'blocked'],
  blocked: ['dispatched', 'working'],
  done: [], // terminal
};

export function isLegalTaskTransition(from: MissionTaskStatus, to: MissionTaskStatus): boolean {
  if (from === to) return true; // idempotent update
  return TASK_TRANSITIONS[from].includes(to);
}

const TERMINAL_MISSION: MissionStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Derive mission status from its task statuses. CONSERVATIVE: only ever
 * promotes an `active` mission to `done` when EVERY task is `done`. Never
 * auto-fails, auto-pauses, or touches an already-terminal mission — those are
 * explicit operator/supervisor decisions. Empty task list → unchanged.
 */
export function rollupMissionStatus(
  taskStatuses: MissionTaskStatus[],
  current: MissionStatus,
): MissionStatus {
  if (TERMINAL_MISSION.includes(current)) return current;
  if (current === 'active' && taskStatuses.length > 0 && taskStatuses.every((s) => s === 'done')) {
    return 'done';
  }
  return current;
}
