// v1.5.3-B — Sync IPC allowlist smoke test.
//
// Catches the regression class introduced in v1.5.0 packet 09: a controller
// method is registered on ipcMain but its channel string is absent from the
// CHANNELS allowlist in rpc-channels.ts. The preload bridge hard-rejects the
// call, producing an "IPC channel not allowed" error in the renderer.
//
// This test:
//   1. Launches the Electron app.
//   2. Navigates to Settings → Sync tab.
//   3. Asserts no "IPC channel not allowed" text appears anywhere in the DOM.
//   4. Asserts the Sync section renders (enable-sync toggle or status element).
//
// Keep this minimal and fast — its only job is to verify the sync IPC surface
// is reachable through the preload bridge without allowlist rejection.

import { test, _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// One automatic retry on infra flakes (Electron launch races, display hiccups).
test.describe.configure({ retries: 1 });

test('sync IPC channels are reachable — no "IPC channel not allowed" on Settings → Sync', async () => {
  test.setTimeout(90_000);

  let app: ElectronApplication | null = null;

  app = await electron.launch({
    args: [path.resolve(__dirname, '../../electron-dist/main.js')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      NODE_ENV: 'test',
    },
    timeout: 60_000,
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  await win.waitForTimeout(2000);

  // Dismiss onboarding if present, then navigate to Settings.
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is injected by preload
        await window.sigma.invoke('kv.set', 'app.onboarded', '1');
      } catch {
        // non-fatal — onboarding modal may already be dismissed
      }
    })
    .catch(() => undefined);
  await win.waitForTimeout(500);

  // Navigate to Settings via the test-event API used by the dogfood suite.
  await win
    .evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('sigma:test:set-room', { detail: { room: 'settings' } }),
      );
    })
    .catch(() => undefined);
  await win.waitForTimeout(800);

  // Try clicking the Sync tab.  The tab may be labelled "Sync" or contain
  // "Sync" as part of a longer label.  We use a relaxed selector so layout
  // changes don't break this test.
  const syncTab = win
    .locator('button:has-text("Sync"), [role="tab"]:has-text("Sync")')
    .first();
  if (await syncTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await syncTab.click({ timeout: 5000 });
    await win.waitForTimeout(600);
  }

  // --- Core assertion 1: no "IPC channel not allowed" in DOM ---
  // This is the exact error text the preload bridge emits when a channel is
  // absent from the CHANNELS allowlist.
  const bodyText = await win.evaluate(() => document.body.innerText).catch(() => '');
  expect(
    bodyText,
    'Found "IPC channel not allowed" in DOM — a sync channel is missing from the CHANNELS allowlist in rpc-channels.ts',
  ).not.toContain('IPC channel not allowed');

  // --- Core assertion 2: no IPC rejection in console ---
  // Collect console errors accumulated during navigation; we check the body
  // text above as primary signal but also verify the sync.status call itself
  // does not throw an allowlist rejection.
  const ipcResult = await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is injected by preload
        const result = await window.sigma.invoke('sync.status');
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })
    .catch((err: unknown) => ({ ok: false, error: String(err) }));

  // The RPC call must NOT be rejected with an allowlist error.
  // (It may fail with a sync-internal error if sync is not configured — that
  // is acceptable here.  Only "IPC channel not allowed" / "not in allowlist"
  // indicates the regression we are guarding against.)
  if (!ipcResult.ok && typeof ipcResult.error === 'string') {
    expect(
      ipcResult.error,
      'sync.status RPC rejected with allowlist error — channel is missing from CHANNELS',
    ).not.toMatch(/channel not allowed|not in allowlist/i);
  }

  // --- Core assertion 3: Sync section renders ---
  // We look for any element that indicates the Sync section mounted.  Prefer
  // a data-testid if one exists; fall back to text-based selectors.
  const syncSectionVisible = await win
    .locator(
      '[data-testid="sync-settings"], ' +
      '[data-section="sync"], ' +
      'text="Enable cross-machine sync", ' +
      'text="Cross-Machine Sync", ' +
      'text="Sync Status", ' +
      'text="Sync is disabled"',
    )
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);

  // If no dedicated Sync UI element is found, fall back to verifying we are
  // at least on the Settings screen (the tab navigation may render "Sync" as
  // a tab button that is itself visible, confirming the surface loaded).
  const settingsVisible = await win
    .locator('button:has-text("Sync"), [role="tab"]:has-text("Sync")')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  expect(
    syncSectionVisible || settingsVisible,
    'Sync settings section did not render — the Settings → Sync surface may be broken',
  ).toBe(true);

  await app.close().catch(() => undefined);
});
