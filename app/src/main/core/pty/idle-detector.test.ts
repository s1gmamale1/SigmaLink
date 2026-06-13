// app/src/main/core/pty/idle-detector.test.ts
import { describe, expect, it, vi } from 'vitest';
import { IdleDetector } from './idle-detector';

function harness(idleMs = 4000) {
  let nowVal = 0;
  let pending: { fn: () => void; id: number } | null = null;
  let nextId = 1;
  const onIdle = vi.fn<(id: string) => void>();
  const det = new IdleDetector({
    idleMs: () => idleMs,
    dedupeMs: 6000,
    onIdle,
    now: () => nowVal,
    setTimer: (fn) => {
      const id = nextId++;
      pending = { fn, id };
      return id;
    },
    clearTimer: (h) => {
      if (pending?.id === h) pending = null;
    },
  });
  return {
    det,
    onIdle,
    advance: (ms: number) => {
      nowVal += ms;
    },
    fire: () => {
      const p = pending;
      pending = null;
      p?.fn();
    },
    hasPending: () => pending !== null,
  };
}

describe('IdleDetector', () => {
  it('fires onIdle after the idle timer elapses', () => {
    const h = harness();
    h.det.onData('s1');
    expect(h.hasPending()).toBe(true);
    h.advance(4000);
    h.fire();
    expect(h.onIdle).toHaveBeenCalledWith('s1');
  });

  it('re-arms on new data (only the latest timer fires)', () => {
    const h = harness();
    h.det.onData('s1');
    h.det.onData('s1'); // cancels the first, arms a fresh one
    h.advance(4000);
    h.fire();
    expect(h.onIdle).toHaveBeenCalledTimes(1);
  });

  it('a bell cancels the pending idle fire', () => {
    const h = harness();
    h.det.onData('s1');
    h.det.noteBell('s1');
    expect(h.hasPending()).toBe(false);
    h.fire(); // nothing pending
    expect(h.onIdle).not.toHaveBeenCalled();
  });

  it('suppresses idle within the dedupe window after a bell', () => {
    const h = harness();
    h.det.noteBell('s1'); // bell at now=0
    h.det.onData('s1'); // more data → re-arm
    h.advance(4000); // now=4000 (< 6000 dedupe)
    h.fire();
    expect(h.onIdle).not.toHaveBeenCalled();
  });

  it('fires idle once the dedupe window has passed since the last bell', () => {
    const h = harness();
    h.det.noteBell('s1'); // bell at now=0
    h.advance(7000); // now=7000
    h.det.onData('s1'); // arm
    h.advance(4000); // now=11000 (> 6000 since bell)
    h.fire();
    expect(h.onIdle).toHaveBeenCalledWith('s1');
  });

  it('forget() clears pending timers', () => {
    const h = harness();
    h.det.onData('s1');
    h.det.forget('s1');
    expect(h.hasPending()).toBe(false);
  });
});
