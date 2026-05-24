import { describe, it, expect } from 'vitest';
import { tasksToRoster, taskCapsule, type OrchestratorTask } from './orchestrator-tasks';

const tasks: OrchestratorTask[] = [
  {
    title: 'Auth',
    prompt: 'add login',
    providerId: 'claude',
    targetFiles: ['src/auth.ts'],
    successCriteria: ['tests pass'],
    outOfScope: ['src/billing/**'],
  },
];

describe('tasksToRoster', () => {
  it('builds a custom roster, one builder entry per task', () => {
    const r = tasksToRoster(tasks);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ role: 'builder', roleIndex: 1, providerId: 'claude' });
  });

  it('assigns sequential roleIndex for multiple tasks', () => {
    const multi: OrchestratorTask[] = [
      { title: 'A', prompt: 'do a', providerId: 'claude', targetFiles: [], successCriteria: [], outOfScope: [] },
      { title: 'B', prompt: 'do b', providerId: 'gemini', targetFiles: [], successCriteria: [], outOfScope: [] },
    ];
    const r = tasksToRoster(multi);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ role: 'builder', roleIndex: 1, providerId: 'claude' });
    expect(r[1]).toMatchObject({ role: 'builder', roleIndex: 2, providerId: 'gemini' });
  });

  it('returns [] for empty tasks', () => {
    expect(tasksToRoster([])).toEqual([]);
  });
});

describe('taskCapsule', () => {
  it('maps a task to a PlanCapsule', () => {
    expect(taskCapsule(tasks[0])).toMatchObject({
      goal: 'add login',
      targetFiles: ['src/auth.ts'],
      successCriteria: ['tests pass'],
      outOfScope: ['src/billing/**'],
    });
  });
});
