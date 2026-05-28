import { describe, it, expect } from 'vitest';
import { analyzeTrace, type TraceEvent } from './trace-analyzer';

// Synthetic CDP DevTools-timeline events. ts/dur are in microseconds. The
// analyzer normalizes timestamps to ms relative to the first event, so the
// origin offset (1_000_000µs = 1s) below should fall out to 0ms windows.
const ORIGIN_US = 1_000_000;

function frame(name: string, tsUs: number): TraceEvent {
  return {
    name,
    cat: 'disabled-by-default-devtools.timeline.frame',
    ph: 'I',
    ts: tsUs,
  };
}

describe('analyzeTrace', () => {
  it('flags a RunTask longer than 50ms as a long task', () => {
    const events: TraceEvent[] = [
      // anchor the origin at ORIGIN_US
      { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: ORIGIN_US, dur: 60_000 },
    ];
    const { windows, longTasks } = analyzeTrace(events);
    expect(longTasks).toBe(1);
    const lt = windows.find((w) => w.kind === 'long-task');
    expect(lt).toBeDefined();
    expect(lt?.startMs).toBeCloseTo(0, 5);
    expect(lt?.endMs).toBeCloseTo(60, 5); // 60ms duration
    expect(lt?.detail).toContain('60.0ms');
  });

  it('does NOT flag a RunTask at or below 50ms', () => {
    const events: TraceEvent[] = [
      { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: ORIGIN_US, dur: 50_000 },
      { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: ORIGIN_US + 100_000, dur: 12_000 },
    ];
    const { windows, longTasks } = analyzeTrace(events);
    expect(longTasks).toBe(0);
    expect(windows.filter((w) => w.kind === 'long-task')).toHaveLength(0);
  });

  it('sums LayoutShift scores into CLS, excluding had_recent_input=true', () => {
    const events: TraceEvent[] = [
      {
        name: 'LayoutShift',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: ORIGIN_US,
        args: { data: { score: 0.12, had_recent_input: false } },
      },
      {
        name: 'LayoutShift',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: ORIGIN_US + 200_000,
        args: { data: { score: 0.08, had_recent_input: false } },
      },
      {
        // This one is user-initiated and must be IGNORED for CLS.
        name: 'LayoutShift',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: ORIGIN_US + 300_000,
        args: { data: { score: 0.5, had_recent_input: true } },
      },
    ];
    const { windows, cls } = analyzeTrace(events);
    expect(cls).toBeCloseTo(0.2, 5); // 0.12 + 0.08, the 0.5 excluded
    const shiftWindows = windows.filter((w) => w.kind === 'layout-shift');
    expect(shiftWindows).toHaveLength(2);
    expect(shiftWindows[0].startMs).toBeCloseTo(0, 5);
    expect(shiftWindows[1].startMs).toBeCloseTo(200, 5);
  });

  it('flags a frame gap larger than ~16.7ms as a dropped frame', () => {
    const events: TraceEvent[] = [
      frame('DrawFrame', ORIGIN_US), // 0ms
      frame('DrawFrame', ORIGIN_US + 16_000), // +16ms — within budget, no flag
      frame('DrawFrame', ORIGIN_US + 116_000), // +100ms gap — janky, flag
    ];
    const { windows } = analyzeTrace(events);
    const dropped = windows.filter((w) => w.kind === 'dropped-frame');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].startMs).toBeCloseTo(16, 5);
    expect(dropped[0].endMs).toBeCloseTo(116, 5);
    expect(dropped[0].detail).toContain('100.0ms');
  });

  it('yields zero windows for a clean trace', () => {
    const events: TraceEvent[] = [
      { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: ORIGIN_US, dur: 8_000 },
      frame('DrawFrame', ORIGIN_US),
      frame('DrawFrame', ORIGIN_US + 16_000),
      frame('DrawFrame', ORIGIN_US + 32_000),
      {
        name: 'LayoutShift',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: ORIGIN_US + 5_000,
        args: { data: { score: 0.0, had_recent_input: false } },
      },
    ];
    const { windows, cls, longTasks } = analyzeTrace(events);
    expect(windows).toHaveLength(0);
    expect(cls).toBeCloseTo(0, 5);
    expect(longTasks).toBe(0);
  });

  it('returns an empty analysis for an empty or invalid trace', () => {
    expect(analyzeTrace([])).toEqual({ windows: [], cls: 0, longTasks: 0 });
    // @ts-expect-error — defensive: non-array input should not throw.
    expect(analyzeTrace(null)).toEqual({ windows: [], cls: 0, longTasks: 0 });
  });

  it('ignores ts:0 metadata events when computing the origin (windows stay video-relative)', () => {
    // Regression: real CDP traces emit phase-'M' metadata at ts:0
    // (process_name, TracingStartedInBrowser…). If those count toward the
    // origin, windows come out as ABSOLUTE timestamps (hundreds of thousands
    // of seconds) instead of relative to the first real event. The live
    // harness run produced 284453s segments before this fix.
    const events: TraceEvent[] = [
      { name: 'process_name', cat: '__metadata', ph: 'M', ts: 0 },
      { name: 'thread_name', cat: '__metadata', ph: 'M', ts: 0 },
      // first REAL event is ~284453s in (mirrors live CDP absolute ts)
      { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: 284_453_000_000, dur: 80_000 },
    ];
    const { windows, longTasks } = analyzeTrace(events);
    expect(longTasks).toBe(1);
    // Must be ~0ms (relative to the first real event), NOT ~284453000ms.
    expect(windows[0].startMs).toBeCloseTo(0, 3);
    expect(windows[0].endMs).toBeCloseTo(80, 3);
  });

  it('sorts mixed flagged windows chronologically', () => {
    const events: TraceEvent[] = [
      frame('DrawFrame', ORIGIN_US + 300_000),
      frame('DrawFrame', ORIGIN_US + 500_000), // gap → dropped frame at 300ms
      { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: ORIGIN_US, dur: 60_000 }, // long task at 0ms
      {
        name: 'LayoutShift',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: ORIGIN_US + 100_000, // shift at 100ms
        args: { data: { score: 0.3, had_recent_input: false } },
      },
    ];
    const { windows } = analyzeTrace(events);
    expect(windows.map((w) => w.kind)).toEqual(['long-task', 'layout-shift', 'dropped-frame']);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].startMs).toBeGreaterThanOrEqual(windows[i - 1].startMs);
    }
  });
});
