// V1.1.1 — Settings → Voice e2e probe.
//
// Walks past onboarding, opens Settings, switches to the Voice tab, clicks
// "Run diagnostics", and asserts the four traffic-light dots render. The
// probe runs against the live main process so the channel allowlist + zod
// schemas + side-band wiring are all exercised end-to-end.

import {
  test,
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function dismissOnboarding(win: Page): Promise<void> {
  // Persist onboarded=1 directly so we don't depend on the (timing-sensitive)
  // multi-step onboarding flow. Same approach as smoke.spec.ts.
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed by the preload bridge
        await window.sigma.invoke('kv.set', 'app.onboarded', '1');
      } catch {
        /* swallow */
      }
    })
    .catch(() => undefined);
  await win.waitForTimeout(300);
  // Close any visible modal X-button defensively.
  const closeBtn = win.locator('button[aria-label="Close"]').first();
  if (await closeBtn.count()) {
    await closeBtn.click({ timeout: 1500 }).catch(() => undefined);
  }
}

test('Settings → Voice diagnostics render four indicator dots', async () => {
  test.setTimeout(180_000);
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [path.resolve(__dirname, '../../electron-dist/main.js')],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
      timeout: 60_000,
    });

    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded').catch(() => undefined);
    await win.waitForTimeout(1500);

    await dismissOnboarding(win);

    // Navigate to Settings room (sidebar entry uses an aria-label).
    const settingsBtn = win.locator('button[aria-label="Settings"]').first();
    if (await settingsBtn.count()) {
      await settingsBtn.click({ timeout: 5000 }).catch(() => undefined);
    } else {
      // Fallback: keyboard navigation. The room id is stored in kv so we can
      // also direct-route via the renderer event bus, but a click first is
      // closer to the user flow we want to assert.
      await win
        .evaluate(() => {
          window.dispatchEvent(
            new CustomEvent('app:navigate', { detail: { pane: 'settings' } }),
          );
        })
        .catch(() => undefined);
    }
    await win.waitForTimeout(800);

    // Switch to the Voice tab.
    const voiceTab = win.locator('button[role="tab"]:has-text("Voice")').first();
    await expect(voiceTab).toBeVisible({ timeout: 5000 });
    await voiceTab.click({ timeout: 3000 });
    await win.waitForTimeout(400);

    const tabRoot = win.locator('[data-testid="voice-settings-tab"]');
    await expect(tabRoot).toBeVisible({ timeout: 5000 });

    // Click "Run diagnostics" to force a fresh probe (also covers the path
    // where the auto-probe on mount failed for some reason).
    const runBtn = win.locator('[data-testid="voice-diagnostics-run"]');
    await expect(runBtn).toBeVisible();
    await runBtn.click({ timeout: 3000 });

    // Wait for dots to populate. The container is rendered after the probe
    // resolves, so we poll for the testid rather than asserting on the
    // initial empty state.
    const dots = win.locator('[data-testid="voice-diagnostics-dots"]');
    await expect(dots).toBeVisible({ timeout: 8000 });

    // Four dots, each with a status data attribute.
    const allDots = win.locator(
      '[data-testid^="voice-diagnostics-dot-"]',
    );
    await expect(allDots).toHaveCount(4, { timeout: 5000 });

    // Permission status row should also be populated.
    const permission = win.locator('[data-testid="voice-permission-status"]');
    await expect(permission).toBeVisible();
    const permText = (await permission.textContent()) ?? '';
    expect(permText.length).toBeGreaterThan(0);
  } finally {
    if (app) {
      await app.close().catch(() => undefined);
    }
  }
});
