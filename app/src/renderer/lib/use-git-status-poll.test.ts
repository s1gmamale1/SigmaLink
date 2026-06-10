// @vitest-environment jsdom
//
// PERF-6 + perf-hot-paths Task 3 — count-only shared per-repo git-status
// poller. The pane-header path now fetches `git.statusSummary` (ONE git proc,
// 2-field payload) instead of the full `git.status`. Factory invariants
// (visibility pause, overlap guard, teardown) are covered by
// shared-poll.test.ts; this file covers the count-only consumer contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    git: {
      statusSummary: vi.fn(),
    },
  },
  rpc: {},
}));

import { rpcSilent } from '@/renderer/lib/rpc';
import { useUncommittedCount, __resetGitStatusPollers } from './use-git-status-poll';

const mockSummary = (
  rpcSilent as unknown as { git: { statusSummary: ReturnType<typeof vi.fn> } }
).git.statusSummary;

beforeEach(() => {
  vi.useFakeTimers();
  mockSummary.mockReset();
  __resetGitStatusPollers();
});

afterEach(() => {
  cleanup();
  __resetGitStatusPollers();
  vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useUncommittedCount — count-only shared poller', () => {
  it('two panes on the same repo share ONE statusSummary RPC and both get the count', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 3, clean: false });

    const a = renderHook(() => useUncommittedCount('/repo'));
    const b = renderHook(() => useUncommittedCount('/repo'));
    await flushMicrotasks();

    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockSummary).toHaveBeenCalledWith('/repo');
    expect(a.result.current).toBe(3);
    expect(b.result.current).toBe(3);
    a.unmount();
    b.unmount();
  });

  it('null summary (not a repo) → null count; null path → disabled, no RPC', async () => {
    mockSummary.mockResolvedValue(null);
    const a = renderHook(() => useUncommittedCount('/not-a-repo'));
    const b = renderHook(() => useUncommittedCount(null));
    await flushMicrotasks();

    expect(a.result.current).toBeNull();
    expect(b.result.current).toBeNull();
    expect(mockSummary).toHaveBeenCalledTimes(1); // only the real path polled
    a.unmount();
    b.unmount();
  });

  it('distinct repo paths each get their own poll', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 1, clean: false });
    const a = renderHook(() => useUncommittedCount('/repo-a'));
    const b = renderHook(() => useUncommittedCount('/repo-b'));
    await flushMicrotasks();

    expect(mockSummary).toHaveBeenCalledTimes(2);
    expect(mockSummary).toHaveBeenCalledWith('/repo-a');
    expect(mockSummary).toHaveBeenCalledWith('/repo-b');
    a.unmount();
    b.unmount();
  });

  it('staggered interval: exactly one recurring tick within the first 15 s window', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 0, clean: true });
    const a = renderHook(() => useUncommittedCount('/repo'));
    await flushMicrotasks();
    expect(mockSummary).toHaveBeenCalledTimes(1); // immediate

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockSummary).toHaveBeenCalledTimes(2); // one phase-offset tick

    a.unmount();
  });

  it('tears down when the last subscriber unmounts (no further RPCs)', async () => {
    mockSummary.mockResolvedValue({ uncommitted: 1, clean: false });
    const a = renderHook(() => useUncommittedCount('/repo'));
    await flushMicrotasks();
    a.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockSummary).toHaveBeenCalledTimes(1);
  });
});
