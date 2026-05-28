// Pure trace analyzer for the combined video + perf-trace review harness.
//
// Input: a flat array of Chromium CDP DevTools-timeline trace events
// ({ name, cat, ph, ts(µs), dur(µs), args }), as collected from
// `Tracing.dataCollected` between `Tracing.start` / `Tracing.end`.
//
// Output: a list of flagged time WINDOWS (ms, relative to the first REAL trace
// event) that an agent then feeds to the video-vision MCP (`video_watch`
// `segments`) to SEE the offending frames. The harness produces the inputs;
// it never calls video-vision itself.
//
// Caveat: windows are relative to the first trace event, which is NOT the exact
// same instant as the recorded video's frame 0 (tracing starts a beat after
// `recordVideo`). The two start within ~a frame or two of app boot, so the
// segments are a close approximation for eyeballing — not frame-accurate to the
// .webm. Good enough to locate the offending moment; don't treat as exact.
//
// Deliberately framework-free (no Playwright/Electron import) so vitest can
// load and unit-test it without a build or node_modules-for-Electron.

/** A single Chromium trace event as emitted by the CDP Tracing domain. */
export interface TraceEvent {
  /** Event name, e.g. "RunTask", "LayoutShift", "DrawFrame". */
  name: string;
  /** Category list, comma-joined, e.g. "disabled-by-default-devtools.timeline". */
  cat?: string;
  /** Phase: "X" complete, "I" instant, "b"/"e" async, etc. */
  ph?: string;
  /** Timestamp in microseconds (monotonic, trace-relative origin). */
  ts: number;
  /** Duration in microseconds (complete events only). */
  dur?: number;
  /** Event payload. LayoutShift carries score under args.data. */
  args?: {
    data?: {
      score?: number;
      had_recent_input?: boolean;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** A flagged span of wall-clock time, in ms relative to the first trace event. */
export interface FlaggedWindow {
  startMs: number;
  endMs: number;
  /** What kind of jank this window represents. */
  kind: 'long-task' | 'layout-shift' | 'dropped-frame';
  /** Human-readable detail (duration, CLS contribution, frame gap, …). */
  detail: string;
}

export interface TraceAnalysis {
  windows: FlaggedWindow[];
  /** Cumulative Layout Shift: sum of layout-shift scores (input-excluded). */
  cls: number;
  /** Count of long tasks (RunTask > 50ms). */
  longTasks: number;
}

// Thresholds. Kept simple and explicit per the harness brief.
const LONG_TASK_US = 50_000; // 50ms — the standard long-task threshold.
const FRAME_GAP_MS = 16.7; // one 60fps frame; gaps beyond this dropped a frame.
const US_PER_MS = 1000;

/**
 * Analyze a CDP DevTools-timeline trace and flag jank windows.
 *
 * Flagging rules (intentionally minimal):
 *   - Long task:    a "RunTask" complete event with dur > 50ms.
 *   - Layout shift: a "LayoutShift" event whose args.data.had_recent_input is
 *                   NOT true contributes its score to CLS and is flagged.
 *                   (Shifts caused by recent user input are excluded — they are
 *                   expected and not penalized, matching the web CLS metric.)
 *   - Dropped frame: a gap > ~16.7ms between consecutive presented frames in
 *                   the timeline.frame category.
 *
 * All `ts`/`dur` are in microseconds; output windows are in milliseconds
 * relative to the first event's timestamp so they line up with a recorded
 * video (whose timeline also starts at ~0).
 */
export function analyzeTrace(events: TraceEvent[]): TraceAnalysis {
  const windows: FlaggedWindow[] = [];
  let cls = 0;
  let longTasks = 0;

  if (!Array.isArray(events) || events.length === 0) {
    return { windows, cls, longTasks };
  }

  // Origin = earliest ts across REAL timeline events. CDP traces include
  // metadata events (phase 'M': process_name, thread_name,
  // TracingStartedInBrowser…) emitted at ts:0 — including those drags the
  // origin to 0 so every window comes out as an ABSOLUTE timestamp (hundreds
  // of thousands of seconds) instead of video-relative. Exclude ph==='M' and
  // ts<=0 so the origin is the first real event and windows line up with the
  // recorded video timeline.
  let originUs = Infinity;
  for (const ev of events) {
    if (typeof ev?.ts === 'number' && ev.ts > 0 && ev.ph !== 'M' && ev.ts < originUs) {
      originUs = ev.ts;
    }
  }
  if (!Number.isFinite(originUs)) return { windows, cls, longTasks };

  const toMs = (tsUs: number): number => (tsUs - originUs) / US_PER_MS;

  // --- Long tasks --------------------------------------------------------
  for (const ev of events) {
    if (ev.name === 'RunTask' && typeof ev.dur === 'number' && ev.dur > LONG_TASK_US) {
      longTasks += 1;
      const startMs = toMs(ev.ts);
      const durMs = ev.dur / US_PER_MS;
      windows.push({
        startMs,
        endMs: startMs + durMs,
        kind: 'long-task',
        detail: `RunTask ${durMs.toFixed(1)}ms (>${LONG_TASK_US / US_PER_MS}ms)`,
      });
    }
  }

  // --- Layout shifts (CLS) ----------------------------------------------
  for (const ev of events) {
    if (ev.name !== 'LayoutShift') continue;
    const data = ev.args?.data;
    if (!data || typeof data.score !== 'number') continue;
    // Exclude shifts triggered by recent user input (expected, not penalized).
    if (data.had_recent_input === true) continue;
    // A zero-score shift contributes nothing and is not jank — don't flag it.
    if (data.score <= 0) continue;
    cls += data.score;
    const atMs = toMs(ev.ts);
    windows.push({
      startMs: atMs,
      // Layout shifts are instant ("I") events; give the window a small visible
      // span so the video reviewer has a frame or two to inspect.
      endMs: atMs + FRAME_GAP_MS,
      kind: 'layout-shift',
      detail: `LayoutShift score ${data.score.toFixed(4)} (cumulative ${cls.toFixed(4)})`,
    });
  }

  // --- Dropped / janky frames -------------------------------------------
  // Presented frames live in the timeline.frame category. Collect their
  // timestamps in order, then flag any inter-frame gap beyond one 60fps frame.
  const frameTsUs = events
    .filter(
      (ev) =>
        typeof ev.ts === 'number' &&
        typeof ev.cat === 'string' &&
        ev.cat.includes('devtools.timeline.frame') &&
        (ev.name === 'DrawFrame' || ev.name === 'PresentationFrame' || ev.name === 'Frame'),
    )
    .map((ev) => ev.ts)
    .sort((a, b) => a - b);

  for (let i = 1; i < frameTsUs.length; i += 1) {
    const gapMs = (frameTsUs[i] - frameTsUs[i - 1]) / US_PER_MS;
    if (gapMs > FRAME_GAP_MS) {
      windows.push({
        startMs: toMs(frameTsUs[i - 1]),
        endMs: toMs(frameTsUs[i]),
        kind: 'dropped-frame',
        detail: `frame gap ${gapMs.toFixed(1)}ms (>${FRAME_GAP_MS}ms — dropped frame)`,
      });
    }
  }

  // Sort windows chronologically so the emitted video-vision segments read
  // left-to-right along the recording timeline.
  windows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return { windows, cls, longTasks };
}
