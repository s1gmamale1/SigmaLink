// @vitest-environment jsdom
//
// PERF-6 (P5 Lane Poll) — coverage for the shared refcounted per-repo
// git-status poller (`useGitStatusPoll` / `useUncommittedCount`).
//
// Asserts the exit criterion "no per-pane duplicate polling":
//   - N panes on the SAME repo path share ONE poll interval / ONE RPC per tick
//   - the resolved GitStatus fans out to every subscriber
//   - distinct repo paths each get their own poll
//   - the interval tears down only when the LAST subscriber unmounts
//   - polling pauses while `document.hidden` and refreshes on becoming visible
//   - the derived `useUncommittedCount` preserves the `number | null` shape
//
// Mocks `@/renderer/lib/rpc`. Uses fake timers + act(); drives the document
// visibility via Object.defineProperty + a dispatched `visibilitychange`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    git: {
      status: vi.fn(),
    },
  },
  rpc: {},
}));

import { rpcSilent } from '@/renderer/lib/rpc';
import type { GitStatus } from '@/shared/types';
import {
  useGitStatusPoll,
  useUncommittedCount,
  __resetGitStatusPollers,
} from './use-git-status-poll';

const mockGitStatus = rpcSilent.git.status as ReturnType<
  typeof vi.fn<(cwd: string) => Promise<GitStatus | null>>
>;

function makeStatus(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    clean: true,
    ...over,
  };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockGitStatus.mockReset();
  setHidden(false);
  __resetGitStatusPollers();
});

afterEach(() => {
  cleanup();
  __resetGitStatusPollers();
  setHidden(false);
  vi.useRealTimers();
});

describe('useGitStatusPoll — shared refcounted per-repo poller', () => {
  it('two panes on the same repo share ONE poll (not two) and both receive the data', async () => {
    mockGitStatus.mockResolvedValue(makeStatus({ unstaged: ['a.ts'], clean: false }));

    const a = renderHook(() => useGitStatusPoll('/repo'));
    const b = renderHook(() => useGitStatusPoll('/repo'));

    await act(async () => {
      await Promise.resolve();
    });

    // ONE immediate poll covered both panes.
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
    expect(mockGitStatus).toHaveBeenCalledWith('/repo');
    // Fans out to BOTH subscribers.
    expect(a.result.current?.unstaged).toEqual(['a.ts']);
    expect(b.result.current?.unstaged).toEqual(['a.ts']);

    // One 15 s interval tick → exactly one more RPC (2 total), not 4.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGitStatus).toHaveBeenCalledTimes(2);

    a.unmount();
    b.unmount();
  });

  it('distinct repo paths each get their own poll', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());

    const a = renderHook(() => useGitStatusPoll('/repo-a'));
    const b = renderHook(() => useGitStatusPoll('/repo-b'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGitStatus).toHaveBeenCalledTimes(2);
    expect(mockGitStatus).toHaveBeenCalledWith('/repo-a');
    expect(mockGitStatus).toHaveBeenCalledWith('/repo-b');

    a.unmount();
    b.unmount();
  });

  it('tears down the shared interval only when the LAST subscriber unmounts', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());

    const a = renderHook(() => useGitStatusPoll('/repo'));
    const b = renderHook(() => useGitStatusPoll('/repo'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    // Drop one — interval keeps running for the survivor.
    a.unmount();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGitStatus).toHaveBeenCalledTimes(2);

    // Drop the last — interval torn down.
    b.unmount();
    const after = mockGitStatus.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(45_000);
      await Promise.resolve();
    });
    expect(mockGitStatus.mock.calls.length).toBe(after);
  });

  it('does not poll when repoPath is null/undefined', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());

    const { result } = renderHook(() => useGitStatusPoll(null));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGitStatus).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('a failing poll degrades quietly — never throws, retains last value', async () => {
    mockGitStatus
      .mockResolvedValueOnce(makeStatus({ staged: ['x'], clean: false }))
      .mockRejectedValueOnce(new Error('git boom'));

    const { result } = renderHook(() => useGitStatusPoll('/repo'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current?.staged).toEqual(['x']);

    // Next tick rejects — value is retained, no throw.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(result.current?.staged).toEqual(['x']);
  });

  // ── Visibility-pause ──────────────────────────────────────────────────────

  it('pauses polling while document.hidden and refreshes immediately on visible', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());

    const h = renderHook(() => useGitStatusPoll('/repo'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGitStatus).toHaveBeenCalledTimes(1); // immediate poll on mount

    // Window goes hidden — the interval is suspended.
    await act(async () => {
      setHidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    const hiddenCount = mockGitStatus.mock.calls.length;

    // Advance well past several 15 s ticks — NO polls while hidden.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(mockGitStatus.mock.calls.length).toBe(hiddenCount);

    // Window becomes visible — immediate refresh fires.
    await act(async () => {
      setHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(mockGitStatus.mock.calls.length).toBe(hiddenCount + 1);

    // …and the interval is re-armed.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGitStatus.mock.calls.length).toBe(hiddenCount + 2);

    h.unmount();
  });
});

describe('useUncommittedCount — derived count', () => {
  it('sums staged + unstaged + untracked', async () => {
    mockGitStatus.mockResolvedValue(
      makeStatus({ staged: ['a'], unstaged: ['b', 'c'], untracked: ['d'], clean: false }),
    );

    const { result } = renderHook(() => useUncommittedCount('/repo'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(4);
  });

  it('returns null for an absent path (no poll) — preserves the number | null shape', async () => {
    const { result } = renderHook(() => useUncommittedCount(undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(mockGitStatus).not.toHaveBeenCalled();
  });
});
