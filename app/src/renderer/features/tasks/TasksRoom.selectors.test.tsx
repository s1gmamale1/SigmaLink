// @vitest-environment jsdom
//
// PERF-3 — render-count assertions for TasksRoom's state subscriptions.
// After migration, dispatching an APPEND_SWARM_MESSAGE (unrelated to tasks)
// must NOT cause the component body to re-execute.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { useAppStateSelector } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';

// Probe does NOT need AppStateProvider — useAppStateSelector reads from the
// module-level appStateStore directly, so we can drive it by calling
// appStateStore.setState without mounting the full provider tree.
// Each selector returns a primitive so Object.is comparisons work correctly.
function TasksProbe({ onRender }: { onRender: () => void }) {
  // Select the task count for the active workspace (a number — Object.is stable).
  useAppStateSelector((s) => {
    const wsId = s.activeWorkspaceId;
    return wsId ? (s.tasks[wsId]?.length ?? 0) : 0;
  });
  onRender();
  return <span data-testid="probe">ok</span>;
}

beforeEach(() => {
  // Set stable initial state before any render so useSyncExternalStore
  // doesn't detect a store mutation between render and subscription setup.
  appStateStore.setState({ ...initialAppState, activeWorkspaceId: 'ws-a' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appStateStore.setState(initialAppState);
});

describe('PERF-3 A3: TasksRoom slice isolation', () => {
  it('a tasks-slice consumer does NOT re-render on APPEND_SWARM_MESSAGE', () => {
    const spy = vi.fn();
    render(<TasksProbe onRender={spy} />);
    const before = spy.mock.calls.length;
    act(() => {
      const snap = appStateStore.getSnapshot();
      appStateStore.setState({
        ...snap,
        swarmMessages: {
          ...snap.swarmMessages,
          'swarm-x': [{ id: 'm1', swarmId: 'swarm-x', fromAgent: 'a', toAgent: '*', body: 'hello', kind: 'SAY' as const, ts: 1 }],
        },
      });
    });
    expect(spy.mock.calls.length).toBe(before);
  });

  it('a tasks-slice consumer DOES re-render when task count for the active workspace changes', () => {
    const spy = vi.fn();
    render(<TasksProbe onRender={spy} />);
    const before = spy.mock.calls.length;
    act(() => {
      const snap = appStateStore.getSnapshot();
      appStateStore.setState({
        ...snap,
        tasks: {
          ...snap.tasks,
          'ws-a': [{ id: 't1', workspaceId: 'ws-a', title: 'New', description: '', status: 'backlog' as const, createdAt: 1, updatedAt: 1, labels: [], assignedSwarmAgentId: null, assignedSessionId: null, assignedSwarmId: null, archivedAt: null }],
        },
      });
    });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});
