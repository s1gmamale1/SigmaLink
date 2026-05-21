// V3-W14-002 — End-to-end smoke for Sigma Assistant powered by the local
// Claude CLI. Skipped when `claude --version` is not on PATH so CI envs
// without the binary don't fail the suite.
//
// What we assert: the user types "what's 2 + 2?" into the Sigma Assistant
// composer, the CLI streams a real reply, and the transcript ends with text
// that contains "4". This is a slow test (real CLI call, real Anthropic
// round-trip) so it owns its own long timeout and runs in workers=1.

import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function claudeInstalled(): boolean {
  try {
    const res = spawnSync('claude', ['--version'], { timeout: 5_000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

test('Sigma Assistant streams a real Claude CLI reply', async () => {
  test.setTimeout(180_000);

  if (!claudeInstalled()) {
    test.skip(true, 'claude CLI not installed — skipping CLI-backed assistant smoke.');
    return;
  }

  // v1.4.7 packet-03 — also gate on SIGMA_E2E_CLAUDE=1. Even when the CLI is
  // present, this test requires (a) valid Anthropic credentials on PATH and
  // (b) network access to the Anthropic API. CI runners typically have the
  // CLI binary present (auto-installed by setup-node's deps) but no
  // credentials, so the test would hang for 90s on the "4" poll before
  // surfacing a useless transcript-empty failure. Local dev opts in via
  // `SIGMA_E2E_CLAUDE=1 pnpm exec playwright test tests/e2e/assistant-cli.spec.ts`.
  if (process.env.SIGMA_E2E_CLAUDE !== '1') {
    test.skip(true, 'Set SIGMA_E2E_CLAUDE=1 to run (requires Anthropic credentials + network).');
    return;
  }

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [path.resolve(__dirname, '../../electron-dist/main.js')],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
      timeout: 60_000,
    });

    const win: Page = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded').catch(() => undefined);
    await win.waitForTimeout(2_500);

    // Skip onboarding if the welcome modal is up.
    for (let i = 0; i < 3; i += 1) {
      const skip = win.locator('button:has-text("Skip")');
      if (await skip.count()) {
        await skip.first().click({ timeout: 3_000 }).catch(() => undefined);
        await win.waitForTimeout(500);
      } else {
        break;
      }
    }
    const continueBtn = win.locator('button:has-text("Continue")');
    while (await continueBtn.count()) {
      await continueBtn.first().click({ timeout: 3_000 }).catch(() => undefined);
      await win.waitForTimeout(400);
      if ((await continueBtn.count()) === 0) break;
    }

    // v1.4.7 packet-03 — Sigma Assistant requires an active workspace since
    // v1.4.0 (SigmaRoom.tsx:180 renders EmptyState when activeWorkspace is null).
    // Open the SigmaLink repo as a workspace + activate it before navigating.
    const repoRoot = path.resolve(__dirname, '../../../');
    await win.evaluate(async (root: string) => {
      const sigma = (window as unknown as {
        sigma: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
      }).sigma;
      await sigma.invoke('kv.set', 'app.onboarded', '1');
      await sigma.invoke('workspaces.open', root);
      window.dispatchEvent(new CustomEvent('sigma:test:activate-workspace', { detail: { rootPath: root } }));
    }, repoRoot);
    await win.waitForTimeout(1_200);

    // Open the Jorvis assistant via the rooms dropdown (v1.1.4+ layout) or
    // fall back to the legacy tab pattern. Post-W-6 rename, label is "Jorvis"
    // / room id is "jorvis".
    try {
      const roomsTrigger = win.getByRole('button', { name: 'Open rooms menu' });
      if (await roomsTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await roomsTrigger.click({ timeout: 3_000 });
        await win.waitForTimeout(300);
        const sigmaItem = win.getByRole('menuitem', { name: 'Jorvis' });
        if (await sigmaItem.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await sigmaItem.click({ timeout: 3_000 });
        } else {
          await win.keyboard.press('Escape').catch(() => undefined);
        }
      }
    } catch {
      // Fall through to legacy tab path.
    }
    // Legacy fallback: right-rail tab (pre-v1.1.4 layout).
    const sigmaTab = win
      .locator('button[role="tab"]', { hasText: /Jorvis|Sigma Assistant|Bridge Assistant/ })
      .first();
    if (await sigmaTab.count()) {
      await sigmaTab.click({ timeout: 5_000 }).catch(() => undefined);
    }
    // Final fallback: sigma:test:set-room event (state.tsx hook).
    await win.evaluate(() => {
      window.dispatchEvent(new CustomEvent('sigma:test:set-room', { detail: { room: 'jorvis' } }));
    });
    await win.waitForTimeout(500);

    // Find the composer via its aria-label (post-v1.4.1 SigmaRoom split, the
    // composer textarea has aria-label="Ask Sigma" — Composer.tsx:100).
    const composer = win.locator('textarea[aria-label="Ask Sigma"]');
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill("what's 2 + 2?");
    await composer.press('Enter');

    // Wait for streamed text containing '4'. We poll the transcript for up
    // to 90s — Claude's first-token latency under cold-cache can be 5-10s.
    const transcript = win.locator('[data-role="assistant-message"], .assistant-message, article');
    await expect
      .poll(
        async () => {
          const texts = await transcript.allTextContents();
          return texts.join('\n');
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toMatch(/\b4\b|four/i);
  } finally {
    if (app) await app.close().catch(() => undefined);
  }
});
