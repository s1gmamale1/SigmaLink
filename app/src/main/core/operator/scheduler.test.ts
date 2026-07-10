// P1b Task 3 — wake scheduler tests. Pure DI module: no DB, no real timers.
// A fake in-memory KV + a fully injected clock/runWake let every hard cap
// (enabled flag, kill-switch, quiet hours, daily budget, the global lock,
// dedupe) be asserted deterministically against fake state.

import { describe, it, expect, vi } from 'vitest';
import { createWakeScheduler, type Wake, type WakeSchedulerDeps } from './scheduler';

function createFakeKv() {
  const store = new Map<string, string>();
  return {
    kvGet: (k: string): string | null => store.get(k) ?? null,
    kvSet: (k: string, v: string): void => {
      store.set(k, v);
    },
  };
}

// The drain loop's await chain (dequeue → gate check → runWake → budget
// write → loop) resolves over a handful of microtask ticks — same pattern
// as core/control/codex-spawn-lock.test.ts's lock-serialization tests.
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const DAY1_10AM = new Date('2026-07-08T10:00:00Z').getTime();

function baseDeps(overrides: Partial<WakeSchedulerDeps> = {}): WakeSchedulerDeps & {
  kv: ReturnType<typeof createFakeKv>;
} {
  const kv = createFakeKv();
  kv.kvSet('missions.autonomy.enabled', '1');
  const deps: WakeSchedulerDeps = {
    runWake: vi.fn().mockResolvedValue(undefined),
    kvGet: kv.kvGet,
    kvSet: kv.kvSet,
    now: () => DAY1_10AM,
    isFrozen: () => false,
    ...overrides,
  };
  return Object.assign(deps, { kv });
}

describe('createWakeScheduler', () => {
  it('enqueue runs a gate-passing wake through runWake and spends budget', async () => {
    const deps = baseDeps();
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    expect(deps.runWake).toHaveBeenCalledWith({ kind: 'review', missionId: 'm1', taskId: 't1' });
    expect(scheduler.wakesSpentToday()).toBe(1);
  });

  it('disabled flag drops all wakes — runWake never called', async () => {
    const onDropped = vi.fn();
    const deps = baseDeps({ onDropped });
    deps.kv.kvSet('missions.autonomy.enabled', '0');
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(deps.runWake).not.toHaveBeenCalled();
    expect(onDropped).toHaveBeenCalledWith({ kind: 'review', missionId: 'm1', taskId: 't1' }, 'disabled');
    expect(scheduler.wakesSpentToday()).toBe(0);
  });

  it('missing enabled key defaults to disabled (safe by default)', async () => {
    const deps = baseDeps();
    deps.kv.kvSet('missions.autonomy.enabled', ''); // never explicitly '1'
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('decompose', 'm1');
    await flush();
    expect(deps.runWake).not.toHaveBeenCalled();
  });

  it('the control kill-switch (isFrozen) drops the wake', async () => {
    const onDropped = vi.fn();
    const deps = baseDeps({ isFrozen: () => true, onDropped });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('decompose', 'm1');
    await flush();
    expect(deps.runWake).not.toHaveBeenCalled();
    expect(onDropped).toHaveBeenCalledWith({ kind: 'decompose', missionId: 'm1', taskId: undefined }, 'frozen');
  });

  // `isQuietHours` reads `hour` via `Date#getHours()` — LOCAL time, not UTC —
  // so these fixtures use the local `Date(y, m, d, h)` constructor (no `Z`
  // suffix) rather than an ISO UTC string, to stay correct regardless of the
  // machine's timezone offset.
  it('quiet hours (overnight range "22-8") drops the wake', async () => {
    const deps = baseDeps({ now: () => new Date(2026, 6, 8, 23, 30, 0).getTime() });
    deps.kv.kvSet('missions.autonomy.quietHours', '22-8');
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(deps.runWake).not.toHaveBeenCalled();
  });

  it('quiet hours (same-day range "1-5") drops inside the window, allows outside it', async () => {
    const inRange = baseDeps({ now: () => new Date(2026, 6, 8, 3, 0, 0).getTime() });
    inRange.kv.kvSet('missions.autonomy.quietHours', '1-5');
    createWakeScheduler(inRange).enqueue('review', 'm1', 't1');
    await flush();
    expect(inRange.runWake).not.toHaveBeenCalled();

    const outOfRange = baseDeps({ now: () => new Date(2026, 6, 8, 6, 0, 0).getTime() });
    outOfRange.kv.kvSet('missions.autonomy.quietHours', '1-5');
    createWakeScheduler(outOfRange).enqueue('review', 'm1', 't1');
    await flush();
    expect(outOfRange.runWake).toHaveBeenCalledTimes(1);
  });

  it('malformed quiet-hours KV never blocks (defensive parse — empty/garbage = never quiet)', async () => {
    const deps = baseDeps();
    deps.kv.kvSet('missions.autonomy.quietHours', 'garbage');
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
  });

  it('budget-exhausted drops the wake — runWake not called past the cap', async () => {
    const onDropped = vi.fn();
    const deps = baseDeps({ dailyBudget: 1, onDropped });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    expect(scheduler.wakesSpentToday()).toBe(1);

    scheduler.enqueue('review', 'm1', 't2'); // distinct taskId — not a dedupe case
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1); // still 1 — dropped by the budget gate
    expect(onDropped).toHaveBeenCalledWith({ kind: 'review', missionId: 'm1', taskId: 't2' }, 'budget-exhausted');
  });

  it('global lock: a second enqueue waits for the first runWake to resolve', async () => {
    const log: string[] = [];
    let resolveFirst!: () => void;
    const runWake = vi.fn((wake: Wake): Promise<void> => {
      log.push(`start:${wake.taskId}`);
      if (wake.taskId === 't1') {
        return new Promise<void>((resolve) => {
          resolveFirst = () => {
            log.push('end:t1');
            resolve();
          };
        });
      }
      log.push(`end:${wake.taskId}`);
      return Promise.resolve();
    });
    const deps = baseDeps({ runWake });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    scheduler.enqueue('review', 'm1', 't2');
    await flush();
    expect(log).toEqual(['start:t1']); // t2 has NOT started — lock held by t1
    expect(runWake).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flush();
    expect(log).toEqual(['start:t1', 'end:t1', 'start:t2', 'end:t2']);
    expect(runWake).toHaveBeenCalledTimes(2);
    expect(scheduler.wakesSpentToday()).toBe(2);
  });

  it('dedupe: a review wake for a taskId already RUNNING is not re-added', async () => {
    const resolvers: Array<() => void> = [];
    const runWake = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const deps = baseDeps({ runWake });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(runWake).toHaveBeenCalledTimes(1);

    scheduler.enqueue('review', 'm1', 't1'); // same taskId, currently running
    await flush();
    expect(runWake).toHaveBeenCalledTimes(1); // deduped, not re-added

    resolvers[0]!();
    await flush();
    expect(scheduler.wakesSpentToday()).toBe(1);

    // No longer queued or running — a later enqueue for the same taskId runs again.
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(runWake).toHaveBeenCalledTimes(2);
    resolvers[1]!();
    await flush();
    expect(scheduler.wakesSpentToday()).toBe(2);
  });

  it('dedupe: a review wake for a taskId already QUEUED (not yet running) is not re-added', async () => {
    const resolvers: Array<() => void> = [];
    const runWake = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const deps = baseDeps({ runWake });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1'); // starts running, holds the lock
    await flush();

    scheduler.enqueue('review', 'm1', 't2'); // queued behind t1
    scheduler.enqueue('review', 'm1', 't2'); // dedup against the queued t2
    await flush();
    expect(runWake).toHaveBeenCalledTimes(1); // only t1 has started

    resolvers[0]!(); // release t1
    await flush();
    expect(runWake).toHaveBeenCalledTimes(2); // t2 starts exactly once
    resolvers[1]!();
    await flush();
  });

  it('decompose wakes (no taskId) are never deduped', async () => {
    const deps = baseDeps();
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('decompose', 'm1');
    scheduler.enqueue('decompose', 'm1');
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(2);
  });

  it('day rollover: the budget counter resets on a new local-date KV key', async () => {
    let clock = DAY1_10AM;
    const deps = baseDeps({ dailyBudget: 1, now: () => clock });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(scheduler.wakesSpentToday()).toBe(1);

    scheduler.enqueue('review', 'm1', 't2'); // same day — budget already exhausted
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1);

    clock = new Date('2026-07-09T10:00:00Z').getTime(); // next day
    expect(scheduler.wakesSpentToday()).toBe(0); // fresh day-key, implicit reset

    scheduler.enqueue('review', 'm1', 't3');
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(2);
    expect(scheduler.wakesSpentToday()).toBe(1);
  });

  it('a rejecting runWake does not spend budget and does not wedge the global lock', async () => {
    const runWake = vi
      .fn<(wake: Wake) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const deps = baseDeps({ runWake });
    const scheduler = createWakeScheduler(deps);
    scheduler.enqueue('review', 'm1', 't1');
    await flush();
    expect(scheduler.wakesSpentToday()).toBe(0); // failed run — no spend

    scheduler.enqueue('review', 'm1', 't2'); // the lock must not be stuck
    await flush();
    expect(runWake).toHaveBeenCalledTimes(2);
    expect(scheduler.wakesSpentToday()).toBe(1);
  });
});
