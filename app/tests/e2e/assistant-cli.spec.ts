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

    // Open Sigma Assistant. The right-rail tab is labelled "Sigma Assistant"
    // post-rebrand; fall back to "Bridge Assistant" when running on a
    // pre-rebrand build.
    const sigmaTab = win
      .locator('button[role="tab"]', { hasText: /Sigma Assistant|Bridge Assistant/ })
      .first();
    if (await sigmaTab.count()) {
      await sigmaTab.click({ timeout: 5_000 }).catch(() => undefined);
    }
    await win.waitForTimeout(500);

    // Find the composer and submit the prompt.
    const composer = win
      .locator('textarea, [contenteditable="true"]')
      .filter({ hasText: '' })
      .last();
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
