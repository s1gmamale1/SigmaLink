// app/src/main/core/pty/attention-detector.test.ts
import { describe, expect, it, vi } from 'vitest';
import { AttentionDetector } from './attention-detector';

function harness(idleMs = 4000) {
  let nowVal = 0;
  let pending: { fn: () => void; id: number } | null = null;
  let nextId = 1;
  const emit = vi.fn<(id: string, reason: 'bell' | 'idle') => void>();
  const det = new AttentionDetector({
    idleMs: () => idleMs,
    dedupeMs: 6000,
    emit,
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
    emit,
    advance: (ms: number) => {
      nowVal += ms;
    },
    fire: () => {
      const p = pending;
      pending = null;
      p?.fn();
    },
  };
}

describe('AttentionDetector', () => {
  it('emits a bell event on a real BEL', () => {
    const h = harness();
    h.det.feed('s1', 'done\x07');
    expect(h.emit).toHaveBeenCalledWith('s1', 'bell');
  });

  it('does NOT emit a bell for an OSC title terminator', () => {
    const h = harness();
    h.det.feed('s1', '\x1b]0;title\x07');
    expect(h.emit).not.toHaveBeenCalledWith('s1', 'bell');
  });

  it('emits an idle event after silence with no bell', () => {
    const h = harness();
    h.det.feed('s1', 'some output');
    h.advance(4000);
    h.fire();
    expect(h.emit).toHaveBeenCalledWith('s1', 'idle');
  });

  it('does not double-fire idle right after a bell (dedupe)', () => {
    const h = harness();
    h.det.feed('s1', 'output\x07'); // bell → emit('bell'), re-arms idle timer
    h.advance(4000); // now 4000 < 6000 dedupe
    h.fire();
    expect(h.emit).toHaveBeenCalledTimes(1); // only the bell
    expect(h.emit).toHaveBeenCalledWith('s1', 'bell');
  });

  it('forget() stops further events for a session', () => {
    const h = harness();
    h.det.feed('s1', 'output');
    h.det.forget('s1');
    h.fire();
    expect(h.emit).not.toHaveBeenCalled();
  });
});
