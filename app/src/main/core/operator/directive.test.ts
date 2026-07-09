// P1b Task 4 — directive builder tests. Pure string-transform assertions:
// no DB, no DI, no I/O. `buildDecomposeDirective`/`buildReviewDirective` are
// the exact prompts the supervisor hands to `assistant.send` for a model
// wake, so what they contain (and what they cap) is the whole contract.

import { describe, it, expect } from 'vitest';
import { buildDecomposeDirective, buildReviewDirective, MAX_EXCERPT_CHARS } from './directive';
import { MAX_ATTEMPTS } from '../missions/state';
import type { Mission, MissionTask } from '../../../shared/types';

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Ship the widget',
    goal: 'Add a working widget export button to the dashboard.',
    origin: 'autonomous',
    clientLabel: null,
    workspaceId: null,
    status: 'active',
    report: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<MissionTask> = {}): MissionTask {
  return {
    id: 't1',
    missionId: 'm1',
    title: 'Wire the export button',
    spec: 'Add a button that calls exportWidget() and downloads the result as JSON.',
    status: 'reviewing',
    assigneeSessionId: 'sess-1',
    worktreePath: '/wt/t1',
    attempt: 1,
    orderIdx: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildDecomposeDirective', () => {
  it('includes the mission title and goal', () => {
    const mission = makeMission();
    const directive = buildDecomposeDirective(mission);
    expect(directive).toContain(mission.title);
    expect(directive).toContain(mission.goal);
  });

  it('names the decomposition tools (add_mission_task, dispatch_task)', () => {
    const directive = buildDecomposeDirective(makeMission());
    expect(directive).toContain('add_mission_task');
    expect(directive).toContain('dispatch_task');
  });
});

describe('buildReviewDirective', () => {
  it('includes the task spec and the pane excerpt', () => {
    const mission = makeMission();
    const task = makeTask();
    const directive = buildReviewDirective(mission, task, 'build succeeded, 0 errors');
    expect(directive).toContain(task.spec);
    expect(directive).toContain('build succeeded, 0 errors');
  });

  it('names all three verdict tools (move_mission_task, dispatch_task, complete_mission)', () => {
    const directive = buildReviewDirective(makeMission(), makeTask(), 'output');
    expect(directive).toContain('move_mission_task');
    expect(directive).toContain('dispatch_task');
    expect(directive).toContain('complete_mission');
  });

  it('offers the dispatch_task retry verdict with the attempt counter (P1c)', () => {
    const directive = buildReviewDirective(makeMission(), makeTask({ attempt: 1 }), 'output');
    expect(directive).toContain('Attempt: 1 of 3');
    expect(directive).toContain('revisedSpec');
    expect(directive).toContain('Retries left: 2');
    // the P1b-era false-promise disclaimer must be gone
    expect(directive).not.toContain('Automatic retry is not available yet');
  });

  it('still offers blocked for tasks that need a human', () => {
    const directive = buildReviewDirective(makeMission(), makeTask(), 'output');
    expect(directive).toContain('blocked');
  });

  it('shows zero retries left at the cap boundary', () => {
    const directive = buildReviewDirective(makeMission(), makeTask({ attempt: 3 }), 'output');
    expect(directive).toContain('Attempt: 3 of 3');
    expect(directive).toContain('Retries left: 0');
  });

  it('caps a very long pane excerpt to MAX_EXCERPT_CHARS', () => {
    const hugeOutput = 'x'.repeat(MAX_EXCERPT_CHARS * 4);
    const directive = buildReviewDirective(makeMission(), makeTask(), hugeOutput);
    // The full uncapped excerpt must never appear verbatim in the directive.
    expect(directive).not.toContain(hugeOutput);
    const runOfX = directive.match(/x+/)?.[0] ?? '';
    expect(runOfX.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });

  it('keeps the TAIL of a truncated excerpt (most recent output survives)', () => {
    const hugeOutput = 'a'.repeat(MAX_EXCERPT_CHARS * 2) + 'TAIL_MARKER';
    const directive = buildReviewDirective(makeMission(), makeTask(), hugeOutput);
    expect(directive).toContain('TAIL_MARKER');
  });

  it('an excerpt shorter than the cap is included verbatim, unmodified', () => {
    const shortOutput = 'short pane output';
    const directive = buildReviewDirective(makeMission(), makeTask(), shortOutput);
    expect(directive).toContain(shortOutput);
  });
});

// P2 Task 6 — optional trailing extraContext param (wake-time memory splice).
// The base builders above must stay byte-identical when extraContext is
// absent or empty; these tests pin that plus the new append behavior.

describe('buildDecomposeDirective — extraContext (P2 T6)', () => {
  it('produces byte-identical output to the pre-P2T6 base when extraContext is absent (pin)', () => {
    const mission = makeMission();
    const expected = [
      `Mission: ${mission.title}`,
      `Goal: ${mission.goal}`,
      '',
      'Decompose this mission into an ordered list of small, concrete tasks:',
      '- Call add_mission_task once per task (each small enough for one agent session to finish in a single pass).',
      '- Then call dispatch_task on the first task to hand it to an agent.',
    ].join('\n');
    expect(buildDecomposeDirective(mission)).toBe(expected);
  });

  it('an empty-string extraContext is byte-identical to omitting the argument entirely', () => {
    const mission = makeMission();
    expect(buildDecomposeDirective(mission, '')).toBe(buildDecomposeDirective(mission));
  });

  it('appends a non-empty extraContext after exactly one blank line', () => {
    const mission = makeMission();
    const base = buildDecomposeDirective(mission);
    const directive = buildDecomposeDirective(mission, '## Operator memory\n- [fact] X: Y');
    expect(directive).toBe(`${base}\n\n## Operator memory\n- [fact] X: Y`);
  });
});

describe('buildReviewDirective — extraContext (P2 T6)', () => {
  it('produces byte-identical output to the pre-P2T6 base when extraContext is absent (pin)', () => {
    const mission = makeMission();
    const task = makeTask();
    const paneExcerpt = 'output';
    const retriesLeft = Math.max(0, MAX_ATTEMPTS - task.attempt);
    const expected = [
      `Mission: ${mission.title}`,
      `Task: ${task.title}`,
      `Spec: ${task.spec}`,
      `Attempt: ${task.attempt} of ${MAX_ATTEMPTS}`,
      '',
      "Recent output from the task's pane:",
      '```',
      paneExcerpt,
      '```',
      '',
      'Review the result and call exactly one verdict tool:',
      '- move_mission_task(status: "done") if the task is complete — then dispatch_task the next backlog task, or complete_mission if this was the last one.',
      `- dispatch_task(taskId, revisedSpec) to RETRY if it failed but a revised approach could succeed — put what went wrong and the corrected instructions into revisedSpec. Retries left: ${retriesLeft}.`,
      '- move_mission_task(status: "blocked") if it needs a human decision or no viable retry remains.',
    ].join('\n');
    expect(buildReviewDirective(mission, task, paneExcerpt)).toBe(expected);
  });

  it('an empty-string extraContext is byte-identical to omitting the argument entirely', () => {
    const mission = makeMission();
    const task = makeTask();
    expect(buildReviewDirective(mission, task, 'output', '')).toBe(buildReviewDirective(mission, task, 'output'));
  });

  it('appends a non-empty extraContext after exactly one blank line', () => {
    const mission = makeMission();
    const task = makeTask();
    const base = buildReviewDirective(mission, task, 'output');
    const directive = buildReviewDirective(mission, task, 'output', '## Operator memory\n- [fact] X: Y');
    expect(directive).toBe(`${base}\n\n## Operator memory\n- [fact] X: Y`);
  });

  it('does not disturb the MAX_ATTEMPTS/attempt lines (P1c behavior) when extraContext is appended', () => {
    const mission = makeMission();
    const task = makeTask({ attempt: 3 });
    const directive = buildReviewDirective(mission, task, 'output', '## Operator memory\n- [fact] X: Y');
    expect(directive).toContain('Attempt: 3 of 3');
    expect(directive).toContain('Retries left: 0');
  });
});
