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

// ── query-map tests ────────────────────────────────────────────────────────

function make() {
  const emitted: Array<{ id: string; reason: string }> = [];
  let t = 1000;
  const d = new AttentionDetector({
    idleMs: () => 5_000,
    emit: (id, reason) => emitted.push({ id, reason }),
    now: () => t,
  });
  return { d, emitted, tick: (ms: number) => { t += ms; } };
}

describe('AttentionDetector query map', () => {
  it('records last attention on a bell and exposes it via lastAttention()', () => {
    const { d } = make();
    d.feed('s1', '\x07'); // BEL
    const a = d.lastAttention('s1');
    expect(a?.reason).toBe('bell');
    expect(a?.ts).toBe(1000);
    expect(d.lastAttention('nope')).toBeNull();
  });

  it('snapshot() returns every tracked session and forget() clears it', () => {
    const { d } = make();
    d.feed('s1', '\x07');
    expect(d.snapshot().get('s1')?.reason).toBe('bell');
    d.forget('s1');
    expect(d.snapshot().has('s1')).toBe(false);
    expect(d.lastAttention('s1')).toBeNull();
  });

  it('still fires the push emit unchanged (no behaviour regression)', () => {
    const { emitted, d } = make();
    d.feed('s1', '\x07');
    expect(emitted).toEqual([{ id: 's1', reason: 'bell' }]);
  });
});

// ── eligibility gate (2026-07-02 review fix D) ─────────────────────────────
// Plain shell / scratch / Dev-workspace panes must not produce "agent needs
// you" — previously `ls` in a shell pane chimed 4s after its output settled.

describe('AttentionDetector — per-session eligibility gate', () => {
  function gated(isEligible: (id: string) => boolean, idleMs = 4000) {
    let nowVal = 0;
    let pending: { fn: () => void; id: number } | null = null;
    let nextId = 1;
    const emit = vi.fn<(id: string, reason: 'bell' | 'idle') => void>();
    const det = new AttentionDetector({
      idleMs: () => idleMs,
      dedupeMs: 6000,
      emit,
      now: () => nowVal,
      isEligible,
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

  it('rejected sessions emit neither bell nor idle', () => {
    const h = gated((id) => id !== 'shell-1');
    h.det.feed('shell-1', 'ls output\x07');
    h.advance(4000);
    h.fire(); // no idle timer should even be armed
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('eligible sessions detect exactly as before', () => {
    const h = gated((id) => id !== 'shell-1');
    h.det.feed('agent-1', 'output\x07');
    expect(h.emit).toHaveBeenCalledWith('agent-1', 'bell');
  });

  it('a throwing gate fails CLOSED — no phantom attention from a broken lookup', () => {
    const h = gated(() => {
      throw new Error('gate exploded');
    });
    h.det.feed('s1', 'output\x07');
    h.advance(4000);
    h.fire();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('omitting the gate keeps every session eligible (back-compat)', () => {
    const h = harness();
    h.det.feed('any', 'output\x07');
    expect(h.emit).toHaveBeenCalledWith('any', 'bell');
  });
});
