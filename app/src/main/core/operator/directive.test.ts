// P1b Task 4 — directive builder tests. Pure string-transform assertions:
// no DB, no DI, no I/O. `buildDecomposeDirective`/`buildReviewDirective` are
// the exact prompts the supervisor hands to `assistant.send` for a model
// wake, so what they contain (and what they cap) is the whole contract.

import { describe, it, expect } from 'vitest';
import { buildDecomposeDirective, buildReviewDirective, MAX_EXCERPT_CHARS } from './directive';
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

  it('does NOT promise automatic re-dispatch (retry loop is not wired yet — P1c)', () => {
    const directive = buildReviewDirective(makeMission(), makeTask(), 'output');
    // The supervisor + state machine have no working→dispatched re-run path yet;
    // the directive must steer an incomplete task to `blocked`, not falsely
    // promise a "working" re-run that would stall the task forever.
    expect(directive).not.toMatch(/re-dispatch/i);
    expect(directive).toContain('blocked');
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
