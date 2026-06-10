// @vitest-environment jsdom
//
// perf-hot-paths Task 2 — useSwarmLiveStats rides the SHARED session-stats
// poller: no own RPC loop, per-session dedupe with PaneHeader, M2 seed
// semantics (no lifetime-count spike) preserved.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const sessionSummaryMock = vi.fn();
const processStatsMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {},
  rpcSilent: {
    usage: {
      sessionSummary: (...args: unknown[]) => sessionSummaryMock(...args),
    },
    pty: {
      processStats: (...args: unknown[]) => processStatsMock(...args),
    },
  },
}));

import { useSwarmLiveStats } from './useSwarmLiveStats';
import { __resetSessionStatsPoller } from '@/renderer/lib/use-session-stats-poll';

function summary(outputTokens: number) {
  return {
    inputTokens: 0,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: null,
    turnCount: 1,
  };
}

async function tickMs(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetSessionStatsPoller();
  processStatsMock.mockResolvedValue({ supported: false, rssBytes: 0, processCount: 0, nodes: [] });
});

afterEach(() => {
  cleanup();
  __resetSessionStatsPoller();
  vi.useRealTimers();
});

describe('useSwarmLiveStats — shared-poller aggregate', () => {
  it('seeds baselines silently (no lifetime spike), then sums per-session deltas', async () => {
    const calls = new Map<string, number>();
    const tokens: Record<string, number[]> = { a: [100, 130, 130], b: [200, 250, 250] };
    sessionSummaryMock.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      const n = calls.get(sessionId) ?? 0;
      calls.set(sessionId, n + 1);
      const seq = tokens[sessionId]!;
      return summary(seq[Math.min(n, seq.length - 1)]!);
    });

    const { result } = renderHook(() => useSwarmLiveStats(['a', 'b'], true));

    // Poll #1 (a:100, b:200) seeds baselines — delta MUST be 0, not 300.
    await tickMs(0);
    expect(result.current.hasData).toBe(true);
    expect(result.current.swarmTokenDelta).toBe(0);

    // Poll #2 (a:+30, b:+50) → summed delta 80.
    await tickMs(3_000);
    expect(result.current.swarmTokenDelta).toBe(80);

    // Poll #3 (no movement) → deltas decay to 0.
    await tickMs(3_000);
    expect(result.current.swarmTokenDelta).toBe(0);
  });

  it('shares the per-session RPC with other subscribers (one sessionSummary per tick per id)', async () => {
    sessionSummaryMock.mockResolvedValue(summary(100));
    const h1 = renderHook(() => useSwarmLiveStats(['a'], true));
    const h2 = renderHook(() => useSwarmLiveStats(['a'], true));
    await tickMs(0);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(1);
    await tickMs(3_000);
    expect(sessionSummaryMock).toHaveBeenCalledTimes(2);
    h1.unmount();
    h2.unmount();
  });

  it('returns EMPTY and never polls when disabled', async () => {
    const { result } = renderHook(() => useSwarmLiveStats(['a'], false));
    await tickMs(6_000);
    expect(sessionSummaryMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ swarmTokenDelta: 0, hasData: false });
  });
});
