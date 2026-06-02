// P4.2 NTF-DIGEST — DailyScheduler unit tests. No real timers: `setTimer` /
// `clearTimer` are stubbed so we assert the computed ms-until-fire, the re-arm
// after a fire, the DST-ish boundary, and cancel — deterministically.

import { describe, expect, it, vi } from 'vitest';
import {
  DailyScheduler,
  msUntilNextLocal,
  type CancelableTimer,
} from './daily-scheduler';

/** A controllable fake timer harness. Records each (cb, ms) armed and lets the
 *  test "fire" the most-recently armed timer. */
function makeTimerHarness() {
  const armed: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = (cb: () => void, ms: number): CancelableTimer => {
    const entry = { cb, ms, cancelled: false };
    armed.push(entry);
    // Return a handle that carries an index so clearTimer can find it.
    return { unref: () => undefined, ...({ __idx: armed.length - 1 } as object) } as CancelableTimer;
  };
  const clearTimer = (handle: CancelableTimer): void => {
    const idx = (handle as unknown as { __idx: number }).__idx;
    if (typeof idx === 'number' && armed[idx]) armed[idx].cancelled = true;
  };
  const fireLast = () => {
    const last = armed[armed.length - 1];
    if (!last || last.cancelled) throw new Error('no live timer to fire');
    last.cb();
  };
  return { armed, setTimer, clearTimer, fireLast };
}

describe('msUntilNextLocal', () => {
  it('targets later today when the time is still ahead', () => {
    const now = new Date(2026, 5, 2, 9, 0, 0, 0); // 09:00 local
    expect(msUntilNextLocal(now, 18, 0)).toBe(9 * 60 * 60 * 1000); // 9h
  });

  it('targets tomorrow when the time already passed today', () => {
    const now = new Date(2026, 5, 2, 20, 0, 0, 0); // 20:00 local
    // next 18:00 is tomorrow → 22h away
    expect(msUntilNextLocal(now, 18, 0)).toBe(22 * 60 * 60 * 1000);
  });

  it('targets tomorrow (never 0) when the time is exactly now', () => {
    const now = new Date(2026, 5, 2, 18, 0, 0, 0);
    expect(msUntilNextLocal(now, 18, 0)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('DailyScheduler', () => {
  it('arms the next local HH:MM with the right delay', () => {
    const h = makeTimerHarness();
    const onFire = vi.fn();
    const sched = new DailyScheduler({
      onFire,
      now: () => new Date(2026, 5, 2, 9, 0, 0, 0),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    expect(sched.isArmed()).toBe(true);
    expect(h.armed).toHaveLength(1);
    expect(h.armed[0].ms).toBe(9 * 60 * 60 * 1000);
  });

  it('fires onFire then re-arms for the next day', () => {
    const h = makeTimerHarness();
    const onFire = vi.fn();
    // now() advances: first arm at 09:00; after fire, "now" is the fire time.
    let nowValue = new Date(2026, 5, 2, 9, 0, 0, 0);
    const sched = new DailyScheduler({
      onFire,
      now: () => nowValue,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    // Simulate the clock reaching the fire time before the callback runs.
    nowValue = new Date(2026, 5, 2, 18, 0, 0, 0);
    h.fireLast();
    expect(onFire).toHaveBeenCalledTimes(1);
    // Re-armed: a second timer is now pending, 24h out.
    expect(h.armed).toHaveLength(2);
    expect(h.armed[1].ms).toBe(24 * 60 * 60 * 1000);
    expect(sched.isArmed()).toBe(true);
  });

  it('does not re-arm if cancelled inside onFire', () => {
    const h = makeTimerHarness();
    const ref: { sched: DailyScheduler | null } = { sched: null };
    const onFire = vi.fn(() => {
      ref.sched?.cancel();
    });
    const sched = new DailyScheduler({
      onFire,
      now: () => new Date(2026, 5, 2, 9, 0, 0, 0),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    ref.sched = sched;
    sched.schedule('18:00');
    h.fireLast();
    expect(onFire).toHaveBeenCalledTimes(1);
    // No re-arm: still only the original (now-spent) timer.
    expect(h.armed).toHaveLength(1);
    expect(sched.isArmed()).toBe(false);
  });

  it('survives an onFire that throws (still re-arms)', () => {
    const h = makeTimerHarness();
    const onFire = vi.fn(() => {
      throw new Error('boom');
    });
    const sched = new DailyScheduler({
      onFire,
      now: () => new Date(2026, 5, 2, 9, 0, 0, 0),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    expect(() => h.fireLast()).not.toThrow();
    expect(h.armed).toHaveLength(2); // re-armed despite the throw
  });

  it('cancel() clears the pending timer', () => {
    const h = makeTimerHarness();
    const sched = new DailyScheduler({
      onFire: vi.fn(),
      now: () => new Date(2026, 5, 2, 9, 0, 0, 0),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    sched.cancel();
    expect(h.armed[0].cancelled).toBe(true);
    expect(sched.isArmed()).toBe(false);
  });

  it('schedule() re-points: cancels the prior timer and arms a fresh one', () => {
    const h = makeTimerHarness();
    const sched = new DailyScheduler({
      onFire: vi.fn(),
      now: () => new Date(2026, 5, 2, 9, 0, 0, 0),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    sched.schedule('10:00');
    expect(h.armed).toHaveLength(2);
    expect(h.armed[0].cancelled).toBe(true); // old one killed
    expect(h.armed[1].ms).toBe(60 * 60 * 1000); // 09:00 → 10:00 = 1h
  });

  it('a malformed HH:MM disables (cancels) rather than throwing', () => {
    const h = makeTimerHarness();
    const sched = new DailyScheduler({
      onFire: vi.fn(),
      now: () => new Date(2026, 5, 2, 9, 0, 0, 0),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    expect(() => sched.schedule('not-a-time')).not.toThrow();
    expect(h.armed[0].cancelled).toBe(true);
    expect(sched.isArmed()).toBe(false);
  });

  it('DST-ish boundary: spring-forward day still yields a positive ~23h delay', () => {
    const h = makeTimerHarness();
    // US spring-forward 2026-03-08 02:00→03:00. At 19:00 on the 8th, next 18:00
    // is the 9th. The exact ms depends on the host TZ, but it MUST be positive
    // and strictly less than 24h would be if a DST gap were swallowed — here we
    // only assert positivity + that the Date-based math produced a same-clock
    // 18:00 target (robust across host zones).
    const now = new Date(2026, 2, 8, 19, 0, 0, 0);
    const sched = new DailyScheduler({
      onFire: vi.fn(),
      now: () => now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.schedule('18:00');
    expect(h.armed[0].ms).toBeGreaterThan(0);
    // Independently: msUntilNextLocal lands on the next calendar day's 18:00.
    const target = new Date(now.getTime() + h.armed[0].ms);
    expect(target.getHours()).toBe(18);
    expect(target.getMinutes()).toBe(0);
  });
});
