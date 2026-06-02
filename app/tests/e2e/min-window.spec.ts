// P5.2 — min-window responsive e2e.
//
// Verifies the responsive auto-collapse driven by `use-breakpoint.ts` at a
// window size the app can ACTUALLY reach. The BrowserWindow has minWidth 1024
// (electron/main.ts), so:
//   - The `compact` (1100px) breakpoint IS reachable — at the minimum width
//     (1024 < 1100) the Sidebar auto-collapses to its icon rail (the persisted
//     one-way collapse). Its `<aside data-testid="sidebar">` stays mounted, but
//     the resize divider (`data-testid="sidebar-resize-handle"`, guarded by
//     `!collapsed`) disappears — that's our collapse signal.
//   - The `narrow` (900px) right-rail breakpoint is NOT reachable via resize
//     (minWidth 1024 > 900), so it is covered by RightRail.rsp unit tests, not
//     here. (smoke.spec.ts's setSize(900,…) likewise clamps to 1024 — which is
//     exactly why its screenshot shows a collapsed sidebar.)
//
// The collapse is asserted at the minimum width regardless of the initial
// collapsed state, so the test is robust to a persisted-collapsed profile.
//
// Boot mirrors smoke.spec.ts (`_electron.launch` against electron-dist/main.js).
// Requires a built app (`npm run build`); exercised in CI's e2e-matrix.

import { test, _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIN_W = 1024; // the BrowserWindow minWidth; below compact(1100) → sidebar collapses
const WIDE_W = 1440; // comfortably above compact
const HEIGHT = 800;
const SETTLE_MS = 700; // resize listener + useSyncExternalStore re-read + React commit

async function setWindowSize(app: ElectronApplication, w: number, h: number): Promise<void> {
  await app
    .evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.setSize(size.w, size.h);
      },
      { w, h },
    )
    .catch(() => undefined);
}

test.describe.configure({ retries: 1 });

test('min-window — sidebar auto-collapses at the minimum window width (compact breakpoint)', async () => {
  test.setTimeout(120_000);

  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../electron-dist/main.js')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
    timeout: 60_000,
  });

  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded').catch(() => undefined);
    await win.waitForTimeout(2500);

    // Defensive: the preload bridge must be present, otherwise the renderer
    // crashed and every assertion below is meaningless.
    const bridgeType = await win.evaluate(
      () => typeof (window as Window & { sigma?: unknown }).sigma,
    );
    expect(bridgeType, 'window.sigma preload bridge must be defined').toBe('object');

    // The sidebar aside is always mounted (it only collapses to an icon rail).
    await expect(win.getByTestId('sidebar'), 'sidebar aside is always mounted').toHaveCount(1);

    // --- Shrink to the minimum width → below compact(1100) → sidebar collapses.
    await setWindowSize(app, MIN_W, HEIGHT);
    await win.waitForTimeout(SETTLE_MS);

    await expect(
      win.getByTestId('sidebar'),
      'sidebar aside stays mounted when collapsed',
    ).toHaveCount(1);
    await expect(
      win.getByTestId('sidebar-resize-handle'),
      'sidebar resize divider is hidden once collapsed below the compact breakpoint',
    ).toHaveCount(0);

    // --- Restore the standard test window size. We do NOT assert the sidebar
    // re-expands — the compact auto-collapse is one-way by design.
    await setWindowSize(app, WIDE_W, HEIGHT);
    await win.waitForTimeout(SETTLE_MS);
    await expect(win.getByTestId('sidebar'), 'sidebar still mounted when wide').toHaveCount(1);
  } finally {
    await app.close().catch(() => undefined);
  }
});
