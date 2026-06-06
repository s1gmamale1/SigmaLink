// C-7 — Orchestrator task type + mappers.
//
// Pure utilities for converting human-authored tasks into the primitives
// consumed by swarms.create (RoleAssignment[]) and panes.brief (PlanCapsule).

import type { RoleAssignment } from './types';
import type { PlanCapsule } from './plan-capsule';

export interface OrchestratorTask {
  title: string;
  prompt: string;
  providerId: string;
  targetFiles: string[];
  successCriteria: string[];
  outOfScope: string[];
  /** BSP-O1 — live status for the Sigma rail Canvas sub-tab. Optional so
   *  existing task literals (no status field) compile without changes. */
  status?: 'pending' | 'running' | 'done' | 'error';
}

/**
 * Maps an array of orchestrator tasks to a custom swarm roster.
 * Each task becomes a `builder` entry with a 1-based `roleIndex`.
 */
export function tasksToRoster(tasks: OrchestratorTask[]): RoleAssignment[] {
  return tasks.map((task, i) => ({
    role: 'builder' as const,
    roleIndex: i + 1,
    providerId: task.providerId,
  }));
}

/**
 * Maps a single orchestrator task to a PlanCapsule for `panes.brief`.
 * The task's `prompt` becomes the capsule's `goal`.
 */
export function taskCapsule(task: OrchestratorTask): PlanCapsule {
  return {
    goal: task.prompt,
    targetFiles: task.targetFiles,
    successCriteria: task.successCriteria,
    outOfScope: task.outOfScope,
  };
}
