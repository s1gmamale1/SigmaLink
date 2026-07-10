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

import { MAX_ATTEMPTS } from '../missions/state';
import type { Mission, MissionTask } from '../../../shared/types';

export const MAX_EXCERPT_CHARS = 4000;

function capExcerpt(excerpt: string): string {
  // Tail, not head: the most recent output (the part a review verdict
  // actually needs — success/failure, final error) is what falls off a
  // head-truncation, so keep the END of an oversized excerpt instead.
  return excerpt.length > MAX_EXCERPT_CHARS ? excerpt.slice(-MAX_EXCERPT_CHARS) : excerpt;
}

// P2 Task 6 — splices the supervisor's recalled-memory block (already built
// and capped by `./context`'s `buildMemoryContext`) onto the end of a
// directive, after exactly one blank line. `extraContext` is falsy-checked
// (covers both `undefined` and `''`, buildMemoryContext's own empty-input
// sentinel), so an absent or empty block leaves the base directive
// byte-identical — no dangling blank line, no bare heading.
function appendContext(base: string, extraContext: string | undefined): string {
  return extraContext ? `${base}\n\n${extraContext}` : base;
}

export function buildDecomposeDirective(mission: Mission, extraContext?: string): string {
  const base = [
    `Mission: ${mission.title}`,
    `Goal: ${mission.goal}`,
    '',
    'Decompose this mission into an ordered list of small, concrete tasks:',
    '- Call add_mission_task once per task (each small enough for one agent session to finish in a single pass).',
    '- Then call dispatch_task on the first task to hand it to an agent.',
  ].join('\n');
  return appendContext(base, extraContext);
}

export function buildReviewDirective(
  mission: Mission,
  task: MissionTask,
  paneExcerpt: string,
  extraContext?: string,
): string {
  const retriesLeft = Math.max(0, MAX_ATTEMPTS - task.attempt);
  const base = [
    `Mission: ${mission.title}`,
    `Task: ${task.title}`,
    `Spec: ${task.spec}`,
    `Attempt: ${task.attempt} of ${MAX_ATTEMPTS}`,
    '',
    "Recent output from the task's pane:",
    '```',
    capExcerpt(paneExcerpt),
    '```',
    '',
    'Review the result and call exactly one verdict tool:',
    '- move_mission_task(status: "done") if the task is complete — then dispatch_task the next backlog task, or complete_mission if this was the last one.',
    `- dispatch_task(taskId, revisedSpec) to RETRY if it failed but a revised approach could succeed — put what went wrong and the corrected instructions into revisedSpec. Retries left: ${retriesLeft}.`,
    '- move_mission_task(status: "blocked") if it needs a human decision or no viable retry remains.',
  ].join('\n');
  return appendContext(base, extraContext);
}

// P2 Task 7 — the postmortem directive: fired after a mission completes (or
// a task auto-blocks at MAX_ATTEMPTS — see supervisor.ts's runReview), this
// is the ONLY point Jorvis is explicitly told to write a memory. The closing
// line hard-caps the brain to a SINGLE `remember` call, then a stop — a
// postmortem wake can never spiral into an unbounded string of tool calls.
// No extraContext slot here (unlike decompose/review): postmortem wakes get
// no memory-recall splice, deliberately kept lean (D4 / plan Task 7).
export function buildPostmortemDirective(mission: Mission, tasks: MissionTask[]): string {
  const lines = [`Mission: ${mission.title}`, `Goal: ${mission.goal}`];
  if (mission.report) {
    lines.push(`Report: ${mission.report}`);
  }
  lines.push('', 'Tasks:');
  for (const task of tasks) {
    lines.push(`- ${task.title} · ${task.status} · attempt ${task.attempt}`);
  }
  lines.push(
    '',
    `Write ONE postmortem memory: call remember(kind: "postmortem", title: "${mission.title}", body: what worked / what failed / what to do differently next time). Then stop — do not call any other tool.`,
  );
  return lines.join('\n');
}
