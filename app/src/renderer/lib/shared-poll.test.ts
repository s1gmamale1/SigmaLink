// @vitest-environment jsdom
//
// perf-hot-paths Task 2 — generic refcounted shared poller. Covers the
// invariants every consumer (git status/activity, session stats) relies on:
// refcount/fan-out, last-subscriber teardown, visibility pause + immediate
// refresh, in-flight overlap guard, per-key phase stagger, quiet failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSharedPoller } from './shared-poll';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createSharedPoller', () => {
  it('two subscribers on one key share ONE fetch per tick and both are notified', async () => {
    const fetch = vi.fn(async (key: string) => `${key}:v${fetch.mock.calls.length}`);
    const poller = createSharedPoller<string>({ intervalMs: 3_000, fetch });
    const seenA = vi.fn();
    const seenB = vi.fn();
    const offA = poller.subscribe('k1', seenA);
    const offB = poller.subscribe('k1', seenB);
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(poller.getSnapshot('k1')).toBe('k1:v1');
    expect(seenA).toHaveBeenCalled();
    expect(seenB).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    offA();
    offB();
    poller.__reset();
  });

  it('tears down the interval when the LAST subscriber leaves', async () => {
    const fetch = vi.fn(async () => 1);
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const offA = poller.subscribe('k1', () => {});
    const offB = poller.subscribe('k1', () => {});
    await flush();
    offA();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(2); // immediate + 1 tick (B still alive)
    offB();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetch).toHaveBeenCalledTimes(2); // dead key — no further polls
    poller.__reset();
  });

  it('pauses while document.hidden and refreshes immediately on visible', async () => {
    const fetch = vi.fn(async () => 1);
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const off = poller.subscribe('k1', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetch).toHaveBeenCalledTimes(1); // occluded → ZERO polls

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2); // immediate refresh on return
    off();
    poller.__reset();
  });

  it('skips ticks while the previous fetch is in flight (overlap guard)', async () => {
    let release: (v: number) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<number>((r) => {
          release = r;
        }),
    );
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const off = poller.subscribe('k1', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6_500); // two ticks elapse, fetch unresolved
    expect(fetch).toHaveBeenCalledTimes(1); // guarded — no stacking

    release(42);
    await flush();
    expect(poller.getSnapshot('k1')).toBe(42);
    off();
    poller.__reset();
  });

  it('staggerPhase: exactly one recurring tick lands within the first interval window', async () => {
    const fetch = vi.fn(async () => 1);
    const poller = createSharedPoller<number>({ intervalMs: 15_000, fetch, staggerPhase: true });
    const off = poller.subscribe('repo-a', () => {});
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1); // immediate first poll
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2); // one phase-offset tick in (0, 15s)
    off();
    poller.__reset();
  });

  it('a rejecting fetch keeps the last good snapshot (degrade quietly)', async () => {
    const fetch = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(7)
      .mockRejectedValueOnce(new Error('rpc down'));
    const poller = createSharedPoller<number>({ intervalMs: 3_000, fetch });
    const off = poller.subscribe('k1', () => {});
    await flush();
    expect(poller.getSnapshot('k1')).toBe(7);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poller.getSnapshot('k1')).toBe(7); // retained
    off();
    poller.__reset();
  });
});
