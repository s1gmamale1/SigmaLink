import {
  test,
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeTrace, type TraceEvent, type FlaggedWindow } from './trace-analyzer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// electron-dist/main.js lives at app/electron-dist/main.js; this spec is at
// app/tests/perf/jank-review.spec.ts.
const mainEntry = path.resolve(__dirname, '../../electron-dist/main.js');
// Artifacts → app/test-results/perf/ (already gitignored). The .webm video +
// the human-readable perf-summary.json land here for the video-vision review
// step. NEVER write the video/trace under docs/06-test (not gitignored).
const perfOutDir = path.resolve(__dirname, '../../test-results/perf');
fs.mkdirSync(perfOutDir, { recursive: true });

/** Borrowed from smoke.spec.ts navTo: room-change via rooms menu, with a
 *  sigma:test:set-room event fallback. Kept self-contained (no cross-import
 *  from tests/e2e so this project stays independent of the e2e suite). */
async function navTo(win: Page, label: string): Promise<boolean> {
  try {
    const trigger = win.getByRole('button', { name: 'Open rooms menu' });
    if (await trigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await trigger.click({ timeout: 3000 });
      await win.waitForTimeout(200);
      const item = win.getByRole('menuitem', { name: label });
      if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
        await item.click({ timeout: 3000 });
        await win.waitForTimeout(400);
        return true;
      }
      await win.keyboard.press('Escape').catch(() => undefined);
    }
  } catch {
    // fall through to the event fallback
  }

  const labelToId: Record<string, string> = {
    'Command Room': 'command',
    Browser: 'browser',
    Skills: 'skills',
    Memory: 'memory',
  };
  const roomId = labelToId[label];
  if (!roomId) return false;
  try {
    await win.evaluate((room: string) => {
      window.dispatchEvent(new CustomEvent('sigma:test:set-room', { detail: { room } }));
    }, roomId);
    await win.waitForTimeout(400);
    const rendered = await win
      .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
      .catch(() => 'unknown');
    return rendered === roomId;
  } catch {
    return false;
  }
}

test.describe.configure({ retries: 0 });

test('jank-review: capture video + CPU-throttled perf trace over a room sweep', async () => {
  test.setTimeout(240_000);

  let app: ElectronApplication | null = null;
  // electron.launch does NOT read use.video from the config — pass recordVideo
  // directly. The .webm path is only resolvable AFTER app.close().
  app = await electron.launch({
    args: [mainEntry],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
    timeout: 60_000,
    recordVideo: { dir: perfOutDir, size: { width: 1440, height: 900 } },
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  await win.waitForTimeout(1500);

  // A firstWindow() Page is Chromium-backed → a CDP session attaches.
  const cdp = await win.context().newCDPSession(win);

  // Throttle the CPU 4x to stretch transient frames so jank is observable in
  // the recording and measurable in the trace.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // Collect the DevTools-timeline trace. Tracing.dataCollected streams chunks;
  // accumulate them and resolve on Tracing.tracingComplete.
  const collected: TraceEvent[] = [];
  // Playwright types the dataCollected payload loosely ({ value: object[] }).
  // The runtime shape is the DevTools trace-event array — cast to TraceEvent.
  cdp.on('Tracing.dataCollected', (payload) => {
    const value = (payload as { value?: unknown }).value;
    if (Array.isArray(value)) collected.push(...(value as TraceEvent[]));
  });
  const tracingComplete = new Promise<void>((resolve) => {
    cdp.on('Tracing.tracingComplete', () => resolve());
  });

  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'blink.user_timing',
        'loading',
      ],
    },
  });

  // --- The interaction under review: the rooms that flashed during smoke ---
  // command → browser → skills → memory. CPU-throttled, so any layout/long-task
  // jank gets stretched into the recording.
  for (const room of ['Command Room', 'Browser', 'Skills', 'Memory'] as const) {
    await navTo(win, room);
    await win.waitForTimeout(700);
  }

  await cdp.send('Tracing.end');
  await tracingComplete;

  // Remove the throttle before teardown (defensive; the page is closing).
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);

  // The video path is only available after the app (and its page) close.
  const videoHandle = win.video();
  await app.close().catch(() => undefined);
  const videoPath = videoHandle ? await videoHandle.path().catch(() => null) : null;

  // --- Analyze + emit the review inputs --------------------------------
  const analysis = analyzeTrace(collected);

  // video_watch segment shape: each flagged window becomes a {start,end} pair
  // (seconds) plus a kind/detail note, so a reviewing agent can call
  // video_watch({ path, segments }) on exactly the janky moments.
  const segments = analysis.windows.map((w: FlaggedWindow) => ({
    startSec: Number((w.startMs / 1000).toFixed(3)),
    endSec: Number((w.endMs / 1000).toFixed(3)),
    kind: w.kind,
    detail: w.detail,
  }));

  const summary = {
    videoPath,
    cpuThrottlingRate: 4,
    cls: analysis.cls,
    longTasks: analysis.longTasks,
    windows: analysis.windows,
    // Ready-to-use video-vision input.
    videoWatch: { path: videoPath, segments },
    traceEventCount: collected.length,
    capturedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(perfOutDir, 'perf-summary.json'), JSON.stringify(summary, null, 2));

  // Review hint for the agent: which video_watch segments to inspect.
  console.log(
    `\n[perf-review] video: ${videoPath ?? '(none)'}\n` +
      `[perf-review] CLS=${analysis.cls.toFixed(4)} longTasks=${analysis.longTasks} ` +
      `flaggedWindows=${analysis.windows.length} traceEvents=${collected.length}\n` +
      (segments.length
        ? `[perf-review] Run video-vision over these segments:\n` +
          segments
            .map(
              (s) =>
                `  video_watch({ path: "${videoPath}", segments: [{ start: ${s.startSec}, end: ${s.endSec} }] })  // ${s.kind}: ${s.detail}`,
            )
            .join('\n') +
          '\n'
        : `[perf-review] No jank windows flagged — clean run.\n`),
  );

  // The spec's JOB is to PRODUCE artifacts, not to gate on perf yet. But assert
  // loudly if the capture pipeline broke (CDP gave us no trace, or video failed
  // to record) so a broken harness fails instead of silently emitting nothing.
  expect(collected.length, 'CDP Tracing returned no events — trace capture broke').toBeGreaterThan(0);
  expect(videoPath, 'recordVideo produced no .webm — video capture broke').toBeTruthy();
  expect(fs.existsSync(path.join(perfOutDir, 'perf-summary.json'))).toBe(true);
});
