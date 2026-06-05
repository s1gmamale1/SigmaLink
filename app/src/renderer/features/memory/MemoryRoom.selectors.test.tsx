// @vitest-environment jsdom
//
// PERF-3 A4 — render-count assertions for MemoryRoom's state subscriptions.
// After migration, dispatching an APPEND_SWARM_MESSAGE (unrelated to memory)
// must NOT cause the component to re-render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { useAppStateSelector } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';

// Probe selects memory count for the active workspace (stable number).
function MemoryProbe({ onRender }: { onRender: () => void }) {
  useAppStateSelector((s) => {
    const wsId = s.activeWorkspaceId;
    return wsId ? (s.memories[wsId]?.length ?? 0) : 0;
  });
  onRender();
  return <span data-testid="probe">ok</span>;
}

beforeEach(() => {
  appStateStore.setState({ ...initialAppState, activeWorkspaceId: 'ws-a' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appStateStore.setState(initialAppState);
});

describe('PERF-3 A4: MemoryRoom slice isolation', () => {
  it('a memory-slice consumer does NOT re-render on APPEND_SWARM_MESSAGE', () => {
    const spy = vi.fn();
    render(<MemoryProbe onRender={spy} />);
    const before = spy.mock.calls.length;
    act(() => {
      const snap = appStateStore.getSnapshot();
      appStateStore.setState({
        ...snap,
        swarmMessages: {
          ...snap.swarmMessages,
          'swarm-x': [{ id: 'm1', swarmId: 'swarm-x', fromAgent: 'a', toAgent: '*', body: 'hi', kind: 'SAY' as const, ts: 1 }],
        },
      });
    });
    expect(spy.mock.calls.length).toBe(before);
  });

  it('a memory-slice consumer DOES re-render when memories for the active workspace change', () => {
    const spy = vi.fn();
    render(<MemoryProbe onRender={spy} />);
    const before = spy.mock.calls.length;
    act(() => {
      const snap = appStateStore.getSnapshot();
      appStateStore.setState({
        ...snap,
        memories: {
          ...snap.memories,
          'ws-a': [{ id: 'n1', workspaceId: 'ws-a', name: 'Note 1', body: '', tags: [], links: [], createdAt: 1, updatedAt: 1, frontmatter: null }],
        },
      });
    });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});
