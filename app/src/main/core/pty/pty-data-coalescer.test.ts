import { describe, it, expect, vi } from 'vitest';
import { PtyDataCoalescer } from './pty-data-coalescer';

/** A manual scheduler: captures the pending callback so the test fires the timer. */
function manualScheduler() {
  let pending: (() => void) | null = null;
  let handle = 0;
  return {
    schedule: (fn: () => void) => {
      pending = fn;
      return ++handle as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => {
      pending = null;
    },
    tick: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed() {
      return pending !== null;
    },
  };
}

function make(opts: { maxBytes?: number } = {}) {
  const emit = vi.fn<(sessionId: string, data: string) => void>();
  const sched = manualScheduler();
  const c = new PtyDataCoalescer({
    emit,
    flushMs: 12,
    maxBytes: opts.maxBytes,
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  return { c, emit, sched };
}

describe('PtyDataCoalescer', () => {
  it('coalesces multiple chunks for one session into a single emit on flush', () => {
    const { c, emit, sched } = make();
    c.push('s1', 'foo');
    c.push('s1', 'bar');
    c.push('s1', 'baz');
    expect(emit).not.toHaveBeenCalled(); // buffered, not yet flushed
    expect(sched.armed).toBe(true);
    sched.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('s1', 'foobarbaz');
  });

  it('flushes each session independently in one timer tick', () => {
    const { c, emit, sched } = make();
    c.push('s1', 'a');
    c.push('s2', 'b');
    sched.tick();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('s1', 'a');
    expect(emit).toHaveBeenCalledWith('s2', 'b');
  });

  it('flush(sessionId) emits that session immediately and leaves others pending', () => {
    const { c, emit, sched } = make();
    c.push('s1', 'x');
    c.push('s2', 'y');
    c.flush('s1');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('s1', 'x');
    sched.tick(); // s2 still flushes on the timer
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('s2', 'y');
  });

  it('flush is a no-op for a session with no buffered data', () => {
    const { c, emit } = make();
    c.flush('nope');
    expect(emit).not.toHaveBeenCalled();
  });

  it('forces an immediate flush when a session exceeds maxBytes', () => {
    const { c, emit, sched } = make({ maxBytes: 5 });
    c.push('s1', 'abc');
    expect(emit).not.toHaveBeenCalled();
    c.push('s1', 'defg'); // total 7 >= 5 → immediate
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('s1', 'abcdefg');
    // The timer armed by the first sub-cap push may still be pending, but it has
    // nothing left to flush — a tick must not produce a second (empty) emit.
    sched.tick();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('ignores empty / non-string chunks', () => {
    const { c, emit, sched } = make();
    c.push('s1', '');
    c.push('s1', undefined as unknown as string);
    expect(sched.armed).toBe(false);
    c.push('s1', 'real');
    sched.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('s1', 'real');
  });

  it('dispose flushes everything and cancels the timer', () => {
    const { c, emit, sched } = make();
    c.push('s1', 'p');
    c.push('s2', 'q');
    c.dispose();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(sched.armed).toBe(false);
  });
});
