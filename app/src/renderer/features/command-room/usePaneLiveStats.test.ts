// @vitest-environment jsdom
//
// BSP-V2 — usePaneLiveStats unit tests.
//
// Coverage:
//   - returns hasData:false when sessionSummary reports turnCount=0.
//   - returns the real totalCostUsd from the ledger.
//   - computes the tok/s estimate: outputTokensDelta / elapsedSeconds.
//   - does NOT emit estTokPerSec on the FIRST poll (no delta yet).
//   - shows real "$" cost (totalCostUsd formatted to 4 decimal places is a
//     rendering concern; the hook returns the raw number).
//
// NOTE: time is controlled via vi.useFakeTimers. We use
// vi.advanceTimersByTimeAsync to advance by a fixed interval (avoids the
// "infinite loop" from runAllTimersAsync re-scheduling the interval
// indefinitely).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ── mock rpc ──────────────────────────────────────────────────────────────────

const sessionSummaryMock = vi.fn();
const processStatsMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    usage: {
      sessionSummary: (...args: unknown[]) => sessionSummaryMock(...args),
    },
    pty: {
      processStats: (...args: unknown[]) => processStatsMock(...args),
    },
  },
}));

import { usePaneLiveStats } from './usePaneLiveStats';
import type { UsageSummary } from '@/shared/types';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: null,
    turnCount: 0,
    ...overrides,
  };
}

/** Advance fake timers by ms AND flush any resolved promises. */
async function tickMs(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  processStatsMock.mockResolvedValue({
    supported: true,
    rssBytes: 0,
    descendantPids: [],
    processCount: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('usePaneLiveStats', () => {
  it('returns hasData:false when turnCount is 0 (no usage yet)', async () => {
    sessionSummaryMock.mockResolvedValue(makeSummary({ turnCount: 0 }));
    const { result } = renderHook(() => usePaneLiveStats('sess-1', true));

    // Allow the initial poll promise to resolve.
    await tickMs(0);

    expect(result.current.hasData).toBe(false);
    expect(result.current.totalCostUsd).toBeNull();
    expect(result.current.estTokPerSec).toBeNull();
    expect(result.current.rssBytes).toBeNull();
  });

  it('returns hasData:true and the real totalCostUsd when turns are recorded', async () => {
    sessionSummaryMock.mockResolvedValue(
      makeSummary({ turnCount: 2, outputTokens: 1000, totalCostUsd: 0.0042 }),
    );
    const { result } = renderHook(() => usePaneLiveStats('sess-2', true));

    await tickMs(0);

    expect(result.current.hasData).toBe(true);
    expect(result.current.totalCostUsd).toBe(0.0042);
  });

  it('estTokPerSec is null on the first poll (no delta to compare against because elapsed~0)', async () => {
    // First poll: 500 output tokens, turnCount=1. The elapsed since mount
    // is ~0ms (immediate), so estTokPerSec stays null (< MIN_ELAPSED_S=1).
    sessionSummaryMock.mockResolvedValue(
      makeSummary({ turnCount: 1, outputTokens: 500, totalCostUsd: 0.001 }),
    );
    const { result } = renderHook(() => usePaneLiveStats('sess-3', true));

    await tickMs(0);

    expect(result.current.hasData).toBe(true);
    // elapsed is essentially 0ms → estTokPerSec is null.
    expect(result.current.estTokPerSec).toBeNull();
  });

  it('computes estTokPerSec on the second poll when elapsed >= 1s', async () => {
    // First poll: 0 output tokens (fresh pane).
    sessionSummaryMock
      .mockResolvedValueOnce(makeSummary({ turnCount: 1, outputTokens: 0, totalCostUsd: 0 }))
      // Second poll: 300 tokens after 3s → 100 tok/s.
      .mockResolvedValueOnce(makeSummary({ turnCount: 1, outputTokens: 300, totalCostUsd: 0.005 }));

    const { result } = renderHook(() => usePaneLiveStats('sess-4', true));

    // First poll fires immediately.
    await tickMs(0);
    expect(result.current.estTokPerSec).toBeNull();

    // Advance 3s so the setInterval fires and elapsedS ≈ 3.
    await tickMs(3_000);

    // 300 tokens / 3s = 100 tok/s.
    expect(result.current.hasData).toBe(true);
    expect(result.current.estTokPerSec).toBe(100);
    expect(result.current.totalCostUsd).toBe(0.005);
  });

  it('shows real $ cost from the usage ledger (totalCostUsd passthrough)', async () => {
    const cost = 0.0123456;
    sessionSummaryMock.mockResolvedValue(
      makeSummary({ turnCount: 1, totalCostUsd: cost }),
    );
    const { result } = renderHook(() => usePaneLiveStats('sess-5', true));

    await tickMs(0);

    expect(result.current.totalCostUsd).toBe(cost);
  });

  it('does not update state after unmount (no setState warning)', async () => {
    sessionSummaryMock.mockResolvedValue(makeSummary({ turnCount: 1 }));
    const { unmount } = renderHook(() => usePaneLiveStats('sess-6', true));

    // Unmount immediately before the initial poll resolves.
    unmount();

    // Advance timers — the interval should be cleared; no setState after unmount.
    await tickMs(6_000);
    // No error thrown = test passes.
  });

  // ── PERF-5 status gate ────────────────────────────────────────────────────────

  it('never polls when enabled=false (status-gated; no interval, no RPC call)', async () => {
    sessionSummaryMock.mockResolvedValue(
      makeSummary({ turnCount: 5, outputTokens: 9999, totalCostUsd: 1.23 }),
    );
    const { result } = renderHook(() => usePaneLiveStats('sess-7', false));

    // Even advancing well past several poll intervals must not trigger a poll.
    await tickMs(0);
    await tickMs(12_000);

    expect(sessionSummaryMock).not.toHaveBeenCalled();
    expect(processStatsMock).not.toHaveBeenCalled();
    expect(result.current.hasData).toBe(false);
    expect(result.current.totalCostUsd).toBeNull();
    expect(result.current.estTokPerSec).toBeNull();
  });

  it('stops polling and hides the badge when enabled flips running → stopped', async () => {
    sessionSummaryMock.mockResolvedValue(
      makeSummary({ turnCount: 1, outputTokens: 100, totalCostUsd: 0.01 }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePaneLiveStats('sess-8', enabled),
      { initialProps: { enabled: true } },
    );

    // Running: the immediate poll populates the badge.
    await tickMs(0);
    expect(result.current.hasData).toBe(true);
    const callsWhileRunning = sessionSummaryMock.mock.calls.length;
    expect(callsWhileRunning).toBeGreaterThan(0);

    // Flip to a non-running status (e.g. exited): the interval is torn down and
    // the badge clears.
    rerender({ enabled: false });
    expect(result.current.hasData).toBe(false);

    // Advancing time must NOT produce any further polls — the ledger is frozen.
    await tickMs(12_000);
    expect(sessionSummaryMock.mock.calls.length).toBe(callsWhileRunning);
  });

  it('returns process RSS while running even before usage turns exist', async () => {
    sessionSummaryMock.mockResolvedValue(makeSummary({ turnCount: 0 }));
    processStatsMock.mockResolvedValue({
      supported: true,
      rssBytes: 512 * 1024 * 1024,
      descendantPids: [123],
      processCount: 2,
    });
    const { result } = renderHook(() => usePaneLiveStats('sess-rss', true));

    await tickMs(0);

    expect(result.current.hasData).toBe(false);
    expect(result.current.rssBytes).toBe(512 * 1024 * 1024);
    expect(result.current.processCount).toBe(2);
  });
});
