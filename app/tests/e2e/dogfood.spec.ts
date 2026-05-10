// P3-S9 — Automated dogfood spec.
//
// Re-verifies the new differentiator surfaces (Operator Console Replays,
// Bridge Conversations panel, OriginLink mount, Diagnostics tab) and the
// two W7 bugs that were "fixed but unverified" since Wave 8 — BUG-W7-003
// (default theme on fresh kv) and BUG-W7-006 (swarms.create race after
// workspaces.open). Each verification runs against a per-test temp
// `userData` directory so the kv table starts empty.
//
// The smoke spec at `smoke.spec.ts` already exercises the happy path on
// the shared dev kv; this file isolates the fresh-install assertions
// without contaminating that profile.

import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const screenshotsDir = path.resolve(__dirname, '../../../docs/06-test/screenshots/dogfood-v1');
fs.mkdirSync(screenshotsDir, { recursive: true });

const tempDirsToClean: string[] = [];

function tempUserData(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sigmalink-dogfood-${label}-`));
  tempDirsToClean.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore — temp cleanup is best-effort */
    }
  }
});

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      path.resolve(__dirname, '../../electron-dist/main.js'),
      `--user-data-dir=${userDataDir}`,
    ],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
    timeout: 60_000,
  });
}

async function dismissOnboarding(win: Page): Promise<void> {
  // Best-effort: walk Continue/Continue/Skip then persist app.onboarded.
  for (let i = 0; i < 2; i++) {
    const cont = win.locator('button:has-text("Continue")').first();
    if (await cont.count()) {
      await cont.click({ timeout: 2000 }).catch(() => undefined);
      await win.waitForTimeout(400);
    }
  }
  const skip = win.locator('button:has-text("Skip")').first();
  if (await skip.count()) {
    await skip.click({ timeout: 2000 }).catch(() => undefined);
  }
  await win
    .evaluate(async () => {
      try {
        await window.sigma.invoke('kv.set', 'app.onboarded', '1');
      } catch {
        /* ignore */
      }
    })
    .catch(() => undefined);
  await win.waitForTimeout(300);
}

async function activateRepoWorkspace(win: Page, repoRoot: string): Promise<string | null> {
  const opened = await win
    .evaluate(async (folder: string) => {
      try {
        const out = (await window.sigma.invoke('workspaces.open', folder)) as {
          ok: boolean;
          data?: { id: string };
        };
        if (out && out.ok && out.data) return out.data.id;
        return null;
      } catch {
        return null;
      }
    }, repoRoot)
    .catch(() => null);
  await win
    .evaluate((rootPath: string) => {
      window.dispatchEvent(
        new CustomEvent('sigma:test:activate-workspace', { detail: { rootPath } }),
      );
    }, repoRoot)
    .catch(() => undefined);
  await win.waitForTimeout(800);
  return opened;
}

async function navTo(win: Page, label: string): Promise<boolean> {
  const btn = win.locator(`button[aria-label="${label}"]`);
  if ((await btn.count()) === 0) return false;
  try {
    await btn.first().click({ timeout: 3000, force: true });
    await win.waitForTimeout(400);
    return true;
  } catch {
    return false;
  }
}

test.setTimeout(180_000);

// ────────────────────────────────────────────────────────────────────────
// (1) Differentiator surface verification — Operator Console Replays tab,
//     Bridge Conversations panel, OriginLink mount, Diagnostics tab.
// ────────────────────────────────────────────────────────────────────────
test('Differentiator surfaces render without console errors', async () => {
  const userData = tempUserData('diff');
  const app = await launchApp(userData);
  const consoleErrors: string[] = [];

  const win = await app.firstWindow({ timeout: 30_000 });
  win.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  win.on('pageerror', (err) => consoleErrors.push(err.message));

  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  await win.waitForTimeout(2500);
  await dismissOnboarding(win);

  const repoRoot = path.resolve(__dirname, '../../../');
  await activateRepoWorkspace(win, repoRoot);
  await win.waitForTimeout(1200);

  // (a) Operator Console → Replays tab.
  const operatorErrorsBefore = consoleErrors.length;
  expect(await navTo(win, 'Operator Console')).toBe(true);
  await win.waitForTimeout(500);
  const operatorRoom = await win
    .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
    .catch(() => 'unknown');
  expect(operatorRoom).toBe('operator');

  // (c) OriginLink mount — the component renders null when no origin row
  //     exists, so DOM-level verification is impossible. Instead probe the
  //     `swarm.origin.get` RPC the component invokes on mount: if the
  //     channel is registered AND the response shape matches `{ok, data}`,
  //     OriginLink can render successfully when an origin row exists.
  const originProbe = await win
    .evaluate(async () => {
      try {
        const env = await window.sigma.invoke('swarm.origin.get', {
          swarmId: '00000000-0000-0000-0000-000000000000',
        });
        return env;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })
    .catch(() => null);
  expect(originProbe).toBeTruthy();
  expect(typeof originProbe).toBe('object');
  expect(originProbe).toHaveProperty('ok');

  const replaysTab = win.locator('button:has-text("Replays")').first();
  expect(await replaysTab.count()).toBeGreaterThan(0);

  await replaysTab.click({ timeout: 3000 }).catch(() => undefined);
  await win.waitForTimeout(500);
  await win.screenshot({
    path: path.join(screenshotsDir, 'df-01-operator-replays.png'),
    fullPage: true,
  });

  // ReplayScrubber shows either "No past swarms in this workspace yet"
  // (empty state) or the swarm picker — both prove it rendered.
  const scrubberEmpty = await win.locator('text=No past swarms in this workspace').count();
  const scrubberPicker = await win.locator('select[aria-label="Select past swarm"]').count();
  expect(scrubberEmpty + scrubberPicker).toBeGreaterThan(0);
  expect(consoleErrors.length).toBe(operatorErrorsBefore);

  // (b) Bridge Assistant → Conversations panel.
  const bridgeErrorsBefore = consoleErrors.length;
  expect(await navTo(win, 'Bridge Assistant')).toBe(true);
  await win.waitForTimeout(800);
  const bridgeRoom = await win
    .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
    .catch(() => 'unknown');
  expect(bridgeRoom).toBe('bridge');

  const panelCount = await win.locator('[data-testid="bridge-conversations-panel"]').count();
  expect(panelCount).toBeGreaterThan(0);
  const newBtn = win.locator('button[aria-label="New conversation"]');
  expect(await newBtn.count()).toBeGreaterThan(0);
  await win.screenshot({
    path: path.join(screenshotsDir, 'df-02-bridge-conversations.png'),
    fullPage: true,
  });
  expect(consoleErrors.length).toBe(bridgeErrorsBefore);

  // (d) Diagnostics tab — Settings room → Diagnostics.
  const diagErrorsBefore = consoleErrors.length;
  expect(await navTo(win, 'Settings')).toBe(true);
  await win.waitForTimeout(400);
  const diagTab = win
    .locator('button:has-text("Diagnostics"), [role="tab"]:has-text("Diagnostics")')
    .first();
  expect(await diagTab.count()).toBeGreaterThan(0);
  await diagTab.click({ timeout: 3000 }).catch(() => undefined);
  await win.waitForTimeout(800);
  // Native modules render either green check or red X — we expect both
  // ok=true on macOS arm64 with the rebuilt better-sqlite3 + node-pty.
  const moduleRows = await win.locator('code').filter({ hasText: /better-sqlite3|node-pty/ }).count();
  expect(moduleRows).toBeGreaterThan(0);
  // "loaded" is the green-check marker text.
  const loadedCount = await win.locator('text=loaded').count();
  expect(loadedCount).toBeGreaterThanOrEqual(2);
  await win.screenshot({
    path: path.join(screenshotsDir, 'df-03-diagnostics.png'),
    fullPage: true,
  });
  expect(consoleErrors.length).toBe(diagErrorsBefore);

  await app.close().catch(() => undefined);
});

// ────────────────────────────────────────────────────────────────────────
// (2) BUG-W7-003 — Default theme on a fresh kv profile is `obsidian`.
// ────────────────────────────────────────────────────────────────────────
test('BUG-W7-003: default theme on fresh kv is obsidian', async () => {
  const userData = tempUserData('w7-003');
  const app = await launchApp(userData);
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  // Allow ThemeProvider's hydrate effect to run (it reads kv.app.theme,
  // sees nothing, and falls back to DEFAULT_THEME).
  await win.waitForTimeout(2500);

  const stored = await win
    .evaluate(async () => {
      try {
        const r = (await window.sigma.invoke('kv.get', 'app.theme')) as
          | { ok: true; data: string | null }
          | { ok: false; error: string }
          | string
          | null;
        if (r && typeof r === 'object' && 'ok' in r && r.ok) return r.data;
        return r;
      } catch (err) {
        return String(err);
      }
    })
    .catch(() => null);

  const docTheme = await win
    .evaluate(() => document.documentElement.getAttribute('data-theme'))
    .catch(() => null);

  await win.screenshot({
    path: path.join(screenshotsDir, 'df-04-w7-003-default-theme.png'),
    fullPage: true,
  });

  // ThemeProvider corrects an unset value to obsidian and writes it back.
  expect(stored === null || stored === 'obsidian').toBeTruthy();
  expect(docTheme).toBe('obsidian');

  await app.close().catch(() => undefined);
});

// ────────────────────────────────────────────────────────────────────────
// (3) BUG-W7-006 — `swarms.create` succeeds immediately after
//     `workspaces.open`. No race, no "no workspace" error.
// ────────────────────────────────────────────────────────────────────────
test('BUG-W7-006: swarms.create after workspaces.open has no race', async () => {
  const userData = tempUserData('w7-006');
  const app = await launchApp(userData);
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  await win.waitForTimeout(2500);
  await dismissOnboarding(win);

  const repoRoot = path.resolve(__dirname, '../../../');

  // Open + immediately create — no setTimeout/waitForTimeout between calls.
  const result = await win
    .evaluate(async (folder: string) => {
      const open = (await window.sigma.invoke('workspaces.open', folder)) as
        | { ok: true; data: { id: string } }
        | { ok: false; error: string };
      if (!open || !('ok' in open) || !open.ok) {
        return { stage: 'open', open };
      }
      const wsId = open.data.id;
      const create = await window.sigma.invoke('swarms.create', {
        workspaceId: wsId,
        mission: 'P3-S9 dogfood verification of BUG-W7-006',
        preset: 'squad',
        roster: [],
      });
      return { stage: 'create', wsId, open, create };
    }, repoRoot)
    .catch((err) => ({ stage: 'throw', err: String(err) }));

  await win.screenshot({
    path: path.join(screenshotsDir, 'df-05-w7-006-swarm-created.png'),
    fullPage: true,
  });

  expect((result as { stage: string }).stage).toBe('create');
  const env = (result as { create: { ok: boolean; data?: { id: string }; error?: string } }).create;
  // Schema: rpc envelope `{ok:true, data: Swarm}`.
  expect(env && typeof env === 'object').toBeTruthy();
  if ('ok' in env) {
    expect(env.ok).toBe(true);
    expect(env.data).toBeTruthy();
    expect(env.data!.id).toMatch(/^[0-9a-f-]{8,}$/i);
  }

  // Verify the swarm row is queryable through the same RPC the renderer
  // would use (no dependence on `workspaces.list`).
  const wsId = (result as { wsId: string }).wsId;
  const list = await win
    .evaluate(async (id: string) => {
      try {
        const r = await window.sigma.invoke('swarms.list', id);
        return r;
      } catch (err) {
        return String(err);
      }
    }, wsId)
    .catch(() => null);
  expect(list).toBeTruthy();
  if (list && typeof list === 'object' && 'ok' in list && (list as { ok: boolean }).ok) {
    const data = (list as { data: Array<unknown> }).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  }

  await app.close().catch(() => undefined);
});
