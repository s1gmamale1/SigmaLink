// P1b Task 4 — pure prompt builders for the supervisor's model-in-the-loop
// wakes. No I/O, no DAO, no DB: every input is already loaded by the caller
// (supervisor.ts), so these are plain, fully-unit-testable string
// transforms — the exact prompt the brain sees for a `decompose` or
// `review` wake.
//
// The review directive NEVER embeds anything beyond a capped tail of the
// pane's own output (the operator's own workspace text, already visible to
// them in the pane) — MAX_EXCERPT_CHARS caps it so a runaway build log can't
// blow the model's context on one wake.

import type { Mission, MissionTask } from '../../../shared/types';

export const MAX_EXCERPT_CHARS = 4000;

function capExcerpt(excerpt: string): string {
  // Tail, not head: the most recent output (the part a review verdict
  // actually needs — success/failure, final error) is what falls off a
  // head-truncation, so keep the END of an oversized excerpt instead.
  return excerpt.length > MAX_EXCERPT_CHARS ? excerpt.slice(-MAX_EXCERPT_CHARS) : excerpt;
}

export function buildDecomposeDirective(mission: Mission): string {
  return [
    `Mission: ${mission.title}`,
    `Goal: ${mission.goal}`,
    '',
    'Decompose this mission into an ordered list of small, concrete tasks:',
    '- Call add_mission_task once per task (each small enough for one agent session to finish in a single pass).',
    '- Then call dispatch_task on the first task to hand it to an agent.',
  ].join('\n');
}

export function buildReviewDirective(mission: Mission, task: MissionTask, paneExcerpt: string): string {
  return [
    `Mission: ${mission.title}`,
    `Task: ${task.title}`,
    `Spec: ${task.spec}`,
    '',
    "Recent output from the task's pane:",
    '```',
    capExcerpt(paneExcerpt),
    '```',
    '',
    'Review the result and call exactly one verdict tool:',
    '- move_mission_task(status: "done") if the task is complete — then dispatch_task the next backlog task, or complete_mission if this was the last one.',
    '- move_mission_task(status: "working") if it needs another pass — the supervisor will re-dispatch it.',
    '- move_mission_task(status: "blocked") if it needs a human to unblock it.',
  ].join('\n');
}
