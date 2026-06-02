// P5.2 — min-window responsive e2e.
//
// Verifies the responsive-collapse contract driven by `use-breakpoint.ts`:
//   - BELOW the `narrow` (900px) breakpoint the Right rail column drops out
//     (RightRail returns its full-bleed body — no `<aside data-testid="right-rail">`).
//   - The Sidebar `<aside data-testid="sidebar">` is ALWAYS rendered (it only
//     collapses to its icon rail; it never unmounts).
//   - Widening back above the breakpoint brings the right rail back.
//
// We deliberately do NOT assert the sidebar re-EXPANDS on widening: the
// `compact` (1100px) auto-collapse is one-way by design (it sets the persisted
// collapsed flag and never auto-re-expands), so an "it re-expands" assertion
// would be wrong. We only assert presence of the sidebar testid.
//
// Boot mirrors smoke.spec.ts (`_electron.launch` against electron-dist/main.js).
// Requires a built app (`npm run build`); this file is authored + typechecked
// here but exercised in CI's e2e-matrix.

import { test, _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Width thresholds mirror src/renderer/lib/use-breakpoint.ts (narrow = 900).
const NARROW_W = 850; // below narrow → right rail collapses out
const WIDE_W = 1200; // above narrow → right rail returns
const HEIGHT = 800;
const SETTLE_MS = 650; // ≥600ms so the resize listener + React re-render settle

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

test('min-window — right rail collapses below the narrow breakpoint, sidebar persists', async () => {
  test.setTimeout(120_000);

  let app: ElectronApplication | null = null;
  app = await electron.launch({
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

    // Start wide so the rail has a chance to mount at all.
    await setWindowSize(app, WIDE_W, HEIGHT);
    await win.waitForTimeout(SETTLE_MS);

    // --- Narrow: right rail drops out, sidebar persists -------------------
    await setWindowSize(app, NARROW_W, HEIGHT);
    await win.waitForTimeout(SETTLE_MS);

    const railCountNarrow = await win.getByTestId('right-rail').count();
    expect(railCountNarrow, 'right rail should collapse out below the narrow breakpoint').toBe(0);

    const sidebarNarrow = win.getByTestId('sidebar');
    await expect(sidebarNarrow, 'sidebar should remain present when narrow').toHaveCount(1);

    // --- Wide again: right rail reappears ---------------------------------
    await setWindowSize(app, WIDE_W, HEIGHT);
    await win.waitForTimeout(SETTLE_MS);

    const railWide = win.getByTestId('right-rail');
    await expect(railWide, 'right rail should reappear above the narrow breakpoint').toHaveCount(1);

    // Sidebar is still present (we do NOT assert it re-expands — one-way collapse).
    await expect(win.getByTestId('sidebar'), 'sidebar should still be present when wide').toHaveCount(1);

    // --- Restore the standard test window size ----------------------------
    await setWindowSize(app, 1440, 900);
    await win.waitForTimeout(SETTLE_MS);
  } finally {
    await app.close().catch(() => undefined);
  }
});
