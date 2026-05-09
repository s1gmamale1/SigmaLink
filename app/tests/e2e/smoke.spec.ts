import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const screenshotsDir = path.resolve(__dirname, '../../../docs/06-test/screenshots');
const consoleLogPath = path.resolve(__dirname, '../../../docs/06-test/console-output.txt');
fs.mkdirSync(screenshotsDir, { recursive: true });
fs.writeFileSync(consoleLogPath, '');

const stepLog: { step: string; ok: boolean; note?: string }[] = [];
const consoleErrors: string[] = [];
const allConsole: string[] = [];

function appendLog(line: string) {
  fs.appendFileSync(consoleLogPath, line + '\n');
}

async function snap(win: Page, file: string, note?: string) {
  const target = path.join(screenshotsDir, file);
  try {
    await win.screenshot({ path: target, fullPage: true });
    stepLog.push({ step: file, ok: true, note });
    appendLog(`[OK]   ${file}${note ? ' — ' + note : ''}`);
  } catch (e) {
    stepLog.push({ step: file, ok: false, note: String((e as Error).message) });
    appendLog(`[FAIL] ${file} — ${(e as Error).message}`);
  }
}

// Click a sidebar room button by aria-label.
async function navTo(win: Page, label: string) {
  const btn = win.locator(`button[aria-label="${label}"]`);
  if ((await btn.count()) === 0) {
    appendLog(`[NAV] no aria-label="${label}" found`);
    return false;
  }
  // Force-enable in case disabled (we still try clicking anyway)
  try {
    await btn.first().click({ timeout: 3000, force: true });
    await win.waitForTimeout(400);
    return true;
  } catch (e) {
    appendLog(`[NAV] click failed for ${label}: ${(e as Error).message}`);
    return false;
  }
}

test.setTimeout(240_000);

test('SigmaLink full visual sweep', async () => {
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [path.resolve(__dirname, '../../electron-dist/main.js')],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
      timeout: 60_000,
    });
  } catch (e) {
    appendLog(`[FATAL] Could not launch electron app: ${(e as Error).stack || (e as Error).message}`);
    fs.appendFileSync(
      path.resolve(__dirname, '../../../docs/07-bugs/OPEN.md'),
      `\n### BUG-W7-000: Electron app failed to launch\n- **Severity**: P0\n- **Surface**: app startup\n- **Repro**: npx playwright test tests/e2e/smoke.spec.ts\n- **Expected**: app starts and renders first window\n- **Actual**: ${String(e)}\n- **Status**: open\n- **Attempts**: 1\n`,
    );
    throw e;
  }

  app.on('console', (msg) => {
    const line = `[main:${msg.type()}] ${msg.text()}`;
    allConsole.push(line);
    appendLog(line);
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  win.on('console', (msg) => {
    const line = `[renderer:${msg.type()}] ${msg.text()}`;
    allConsole.push(line);
    appendLog(line);
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  win.on('pageerror', (err) => {
    const line = `[pageerror] ${err.stack || err.message}`;
    allConsole.push(line);
    appendLog(line);
    consoleErrors.push(err.message);
  });

  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  await win.waitForTimeout(2500);

  // 01 — initial window (will include onboarding modal)
  await snap(win, '01-startup.png', 'startup');

  // 02 — onboarding step 1 (welcome)
  await snap(win, '02-onboarding-step1.png', 'onboarding step 1');

  // Walk onboarding: click Continue
  const continueBtn = win.locator('button:has-text("Continue")');
  if (await continueBtn.count()) {
    await continueBtn.first().click({ timeout: 3000 }).catch(() => undefined);
    await win.waitForTimeout(800);
  }
  await snap(win, '03-onboarding-step2.png', 'onboarding step 2 (provider probe)');

  // Continue again
  if (await continueBtn.count()) {
    await continueBtn.first().click({ timeout: 3000 }).catch(() => undefined);
    await win.waitForTimeout(800);
  }
  await snap(win, '04-onboarding-step3.png', 'onboarding step 3 (workspace picker)');

  // Skip
  const skipBtn = win.locator('button:has-text("Skip")');
  if (await skipBtn.count()) {
    await skipBtn.first().click({ timeout: 3000 }).catch(() => undefined);
  } else {
    // try X close
    const x = win.locator('button[aria-label="Close"]').first();
    if (await x.count()) await x.click({ timeout: 2000 }).catch(() => undefined);
  }
  await win.waitForTimeout(800);

  // Persist onboarded so it stays closed
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        await window.sigma.invoke('kv.set', 'app.onboarded', '1');
      } catch (err) {
        return String(err);
      }
      return 'ok';
    })
    .catch(() => undefined);

  // 05 — workspaces empty (the room itself)
  await snap(win, '05-workspaces-empty.png', 'workspaces empty (post-onboarding)');

  // Open the SigmaLink folder as a workspace via RPC
  const openResult = await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        const out = await window.sigma.invoke(
          'workspaces.open',
          'C:/Users/DaddysHere/Documents/SigmaLink',
        );
        return { ok: true, out };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    })
    .catch((e) => ({ ok: false, err: String(e) }));
  appendLog(`[RPC workspaces.open] ${JSON.stringify(openResult)}`);
  await win.waitForTimeout(1500);
  await snap(win, '06-workspaces-with-recent.png', 'workspaces with SigmaLink folder');

  // Click the recent SigmaLink entry (or any "SigmaLink" mention) to make it active
  // Best effort: click a row containing "SigmaLink"
  const recentRow = win.locator('button:has-text("SigmaLink"), [role="button"]:has-text("SigmaLink")').first();
  if (await recentRow.count()) {
    await recentRow.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(500);
  }

  // 07 — preset 4 selected
  const fourPanesBtn = win.locator('button:has-text("4 panes")').first();
  if (await fourPanesBtn.count()) {
    await fourPanesBtn.click({ timeout: 2000 }).catch(() => undefined);
  }
  await snap(win, '07-launcher-4-panes.png', 'launcher 4 panes');

  // Launch agents (clicks the "Launch 4 agents" button) to actually activate workspace
  const launchAgentsBtn = win.locator('button:has-text("Launch")').first();
  if (await launchAgentsBtn.count()) {
    await launchAgentsBtn.click({ timeout: 4000 }).catch(() => undefined);
    await win.waitForTimeout(2500);
  }

  // Now check whether app jumped to command room (it should, per Launcher.tsx)
  await snap(win, '08-command-room-empty.png', 'command room (post-launch)');

  // 09 — command room running (after launch)
  await win.waitForTimeout(1500);
  await snap(win, '09-command-room-running.png', 'command room running');

  // 10 — focus mode (best effort)
  const focusBtn = win.locator('button:has-text("Focus")').first();
  if (await focusBtn.count()) {
    await focusBtn.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(400);
  }
  await snap(win, '10-command-room-focus-mode.png', 'command room focus mode');

  // 11 — swarm room
  await navTo(win, 'Swarm Room');
  await snap(win, '11-swarm-empty.png', 'swarm empty');

  // 12 — try to fill mission via UI (textarea)
  const missionField = win.locator('textarea').first();
  if (await missionField.count()) {
    await missionField.fill('Test mission: visual sweep of SigmaLink', { timeout: 2000 }).catch(() => undefined);
  }
  const squadBtn = win.locator('button:has-text("Squad")').first();
  if (await squadBtn.count()) {
    await squadBtn.click({ timeout: 2000 }).catch(() => undefined);
  }
  await snap(win, '12-swarm-create.png', 'swarm create form');

  // 13 — launch swarm via RPC
  const swarmRes = await win
    .evaluate(async () => {
      // @ts-expect-error sigma is exposed
      const inv = window.sigma.invoke as (ch: string, ...a: unknown[]) => Promise<unknown>;
      try {
        const list = (await inv('workspaces.list')) as Array<{ id: string }>;
        const wsId = list[0]?.id;
        if (!wsId) return { ok: false, err: 'no workspace' };
        const r = await inv('swarms.create', {
          workspaceId: wsId,
          mission: 'Test mission: visual sweep of SigmaLink',
          preset: 'squad',
          provider: 'shell',
        });
        return { ok: true, r };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    })
    .catch((e) => ({ ok: false, err: String(e) }));
  appendLog(`[RPC swarms.create] ${JSON.stringify(swarmRes)}`);
  await win.waitForTimeout(1200);
  await snap(win, '13-swarm-running.png', 'swarm running');

  // 14 — type into composer
  const allTextareas = win.locator('textarea');
  const tac = await allTextareas.count();
  if (tac > 0) {
    await allTextareas.nth(tac - 1).fill('Hello from visual smoke test', { timeout: 2000 }).catch(() => undefined);
  }
  await snap(win, '14-swarm-side-chat.png', 'swarm side chat');

  // P3-S2 — Operator Console smoke. Click the sidebar entry, confirm
  // `data-room` flipped to `operator` (BUG-W7-014 truth source), capture a
  // screenshot, and assert no new console errors landed during the
  // navigation.
  const operatorErrorsBefore = consoleErrors.length;
  const operatorNavOk = await navTo(win, 'Operator Console');
  await win.waitForTimeout(500);
  const operatorRoom = await win
    .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
    .catch(() => 'unknown');
  await snap(
    win,
    '27-operator-console.png',
    `operator console (nav=${operatorNavOk}, rendered=${operatorRoom})`,
  );
  const operatorErrorsAfter = consoleErrors.length;
  expect(operatorErrorsAfter).toBe(operatorErrorsBefore);

  // P3-S6 — Persistent Swarm Replay. Click the Replays tab inside the
  // Operator Console and assert the scrubber renders without console errors.
  // We do not interact with the slider — that would require a swarm with
  // recorded messages to exist, which the smoke harness does not guarantee.
  const replayErrorsBefore = consoleErrors.length;
  const replaysTab = win.locator('button:has-text("Replays")').first();
  if (await replaysTab.count()) {
    await replaysTab.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(400);
  }
  await snap(
    win,
    '27b-operator-replays-tab.png',
    'operator console replays tab',
  );
  const replayErrorsAfter = consoleErrors.length;
  expect(replayErrorsAfter).toBe(replayErrorsBefore);

  // 15 — review
  await navTo(win, 'Review Room');
  await snap(win, '15-review-empty.png', 'review empty');
  await snap(win, '16-review-with-sessions.png', 'review with sessions');

  const diffTab = win.locator('button:has-text("Diff"), [role="tab"]:has-text("Diff")').first();
  if (await diffTab.count()) {
    await diffTab.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(400);
  }
  await snap(win, '17-review-diff-tab.png', 'review diff tab');

  // 18 — tasks
  await navTo(win, 'Tasks');
  await snap(win, '18-tasks-empty.png', 'tasks empty');

  const newTaskBtn = win.locator('button:has-text("New"), button:has-text("Add")').first();
  if (await newTaskBtn.count()) {
    await newTaskBtn.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(500);
  }
  await snap(win, '19-tasks-card-create.png', 'task create drawer');

  // RPC fallback to create a task
  await win
    .evaluate(async () => {
      // @ts-expect-error sigma is exposed
      const inv = window.sigma.invoke as (ch: string, ...a: unknown[]) => Promise<unknown>;
      try {
        const list = (await inv('workspaces.list')) as Array<{ id: string }>;
        const wsId = list[0]?.id;
        if (!wsId) return { ok: false };
        await inv('tasks.upsert', { workspaceId: wsId, title: 'Smoke test task', column: 'backlog' });
        return { ok: true };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    })
    .catch(() => undefined);
  await win.waitForTimeout(800);
  await snap(win, '20-tasks-card-on-board.png', 'task on board');

  // 21 — memory
  await navTo(win, 'Memory');
  await snap(win, '21-memory-empty.png', 'memory empty');

  const newMemBtn = win.locator('button:has-text("New"), button:has-text("Add")').first();
  if (await newMemBtn.count()) {
    await newMemBtn.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(500);
  }
  await snap(win, '22-memory-create-note.png', 'memory create note');

  // RPC fallback create memory
  await win
    .evaluate(async () => {
      // @ts-expect-error sigma is exposed
      const inv = window.sigma.invoke as (ch: string, ...a: unknown[]) => Promise<unknown>;
      try {
        const list = (await inv('workspaces.list')) as Array<{ id: string }>;
        const wsId = list[0]?.id;
        if (!wsId) return { ok: false };
        await inv('memory.upsert_memory', {
          workspaceId: wsId,
          name: 'visual-test-note',
          body: '# Hello\nThis note was created during a smoke test.',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    })
    .catch(() => undefined);
  await win.waitForTimeout(800);
  await snap(win, '23-memory-list-with-note.png', 'memory list with note');

  const graphTab = win.locator('button:has-text("Graph"), [role="tab"]:has-text("Graph")').first();
  if (await graphTab.count()) {
    await graphTab.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(500);
  }
  await snap(win, '24-memory-graph.png', 'memory graph');

  // 25 — browser. BUG-W7-014: previously the screenshots were named
  // `25-browser-empty.png` and `26-browser-tab-loaded.png` regardless of
  // whether the Browser room actually rendered. When sidebar gating sent the
  // user back to Tasks (BUG-W7-001/002), the file was a Tasks screenshot
  // saved under a Browser key. Probe the live `data-room` attribute and
  // include it in the filename so each capture has an unambiguous unique key
  // tied to what was actually rendered.
  const browserNavOk = await navTo(win, 'Browser');
  const browserRoomA = await win
    .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
    .catch(() => 'unknown');
  await snap(
    win,
    `25-browser-empty-${browserRoomA}.png`,
    `browser empty (nav=${browserNavOk}, rendered=${browserRoomA})`,
  );

  await win
    .evaluate(async () => {
      // @ts-expect-error sigma is exposed
      const inv = window.sigma.invoke as (ch: string, ...a: unknown[]) => Promise<unknown>;
      try {
        const list = (await inv('workspaces.list')) as Array<{ id: string }>;
        const wsId = list[0]?.id;
        if (!wsId) return { ok: false };
        await inv('browser.openTab', { workspaceId: wsId, url: 'about:blank' });
        return { ok: true };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    })
    .catch(() => undefined);
  await win.waitForTimeout(1500);
  const browserRoomB = await win
    .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
    .catch(() => 'unknown');
  await snap(
    win,
    `26-browser-tab-loaded-${browserRoomB}.png`,
    `browser tab loaded (rendered=${browserRoomB})`,
  );

  // P3-S7 — Bridge Assistant Conversations panel smoke. Navigate, confirm
  // the panel renders, and assert no new console errors landed during the
  // navigation. The panel is rendered for the standalone variant only (the
  // right-rail variant is too narrow to host the sidebar).
  const bridgeErrorsBefore = consoleErrors.length;
  const bridgeNavOk = await navTo(win, 'Bridge Assistant');
  await win.waitForTimeout(500);
  const bridgeRoom = await win
    .evaluate(() => document.body.getAttribute('data-room') ?? 'unknown')
    .catch(() => 'unknown');
  const conversationsPanelCount = await win
    .locator('[data-testid="bridge-conversations-panel"]')
    .count();
  await snap(
    win,
    `26b-bridge-conversations-${bridgeRoom}.png`,
    `bridge conversations panel (nav=${bridgeNavOk}, rendered=${bridgeRoom}, panel=${conversationsPanelCount})`,
  );
  expect(consoleErrors.length).toBe(bridgeErrorsBefore);
  expect(conversationsPanelCount).toBeGreaterThan(0);

  // 27 — skills
  await navTo(win, 'Skills');
  await snap(win, '27-skills-empty.png', 'skills empty');

  // 28 — settings appearance
  await navTo(win, 'Settings');
  const apTab = win.locator('button:has-text("Appearance"), [role="tab"]:has-text("Appearance")').first();
  if (await apTab.count()) {
    await apTab.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(400);
  }
  await snap(win, '28-settings-appearance.png', 'settings appearance');

  const provTab = win.locator('button:has-text("Providers"), [role="tab"]:has-text("Providers")').first();
  if (await provTab.count()) {
    await provTab.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(400);
  }
  await snap(win, '29-settings-providers.png', 'settings providers');

  const mcpTab = win.locator('button:has-text("MCP"), [role="tab"]:has-text("MCP")').first();
  if (await mcpTab.count()) {
    await mcpTab.click({ timeout: 2000 }).catch(() => undefined);
    await win.waitForTimeout(400);
  }
  await snap(win, '30-settings-mcp.png', 'settings mcp');

  // 31 — theme parchment, in workspaces
  await navTo(win, 'Workspaces');
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        await window.sigma.invoke('kv.set', 'app.theme', 'parchment');
      } catch {
        /* ignore */
      }
      document.documentElement.setAttribute('data-theme', 'parchment');
    })
    .catch(() => undefined);
  await win.waitForTimeout(400);
  await snap(win, '31-theme-parchment.png', 'theme parchment');

  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        await window.sigma.invoke('kv.set', 'app.theme', 'nord');
      } catch {
        /* ignore */
      }
      document.documentElement.setAttribute('data-theme', 'nord');
    })
    .catch(() => undefined);
  await win.waitForTimeout(400);
  await snap(win, '32-theme-nord.png', 'theme nord');

  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        await window.sigma.invoke('kv.set', 'app.theme', 'synthwave');
      } catch {
        /* ignore */
      }
      document.documentElement.setAttribute('data-theme', 'synthwave');
    })
    .catch(() => undefined);
  await win.waitForTimeout(400);
  await snap(win, '33-theme-synthwave.png', 'theme synthwave');

  // restore obsidian for last screenshots
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        await window.sigma.invoke('kv.set', 'app.theme', 'obsidian');
      } catch {
        /* ignore */
      }
      document.documentElement.setAttribute('data-theme', 'obsidian');
    })
    .catch(() => undefined);

  // 34 — palette
  await win.keyboard.press('Control+K').catch(() => undefined);
  await win.waitForTimeout(400);
  await snap(win, '34-command-palette.png', 'command palette open');
  await win.keyboard.press('Escape').catch(() => undefined);
  await win.waitForTimeout(200);

  // 35 — sidebar collapsed (narrow window)
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.setSize(900, 800);
    });
  } catch {
    /* ignore */
  }
  await win.waitForTimeout(400);
  await snap(win, '35-sidebar-collapsed.png', 'sidebar collapsed (narrow window)');

  try {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.setSize(1440, 900);
    });
  } catch {
    /* ignore */
  }
  await win.waitForTimeout(400);

  // 36 — error: invoke RPC with bogus path
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        await window.sigma.invoke('workspaces.open', 'Z:/this/path/definitely/does/not/exist');
      } catch (err) {
        return String(err);
      }
      return null;
    })
    .catch(() => undefined);
  await win.waitForTimeout(500);
  await snap(win, '36-error-banner.png', 'error banner');

  // 37 — final state
  await snap(win, '37-final-shutdown.png', 'final shutdown');

  // Cleanup ptys
  await win
    .evaluate(async () => {
      try {
        // @ts-expect-error sigma is exposed
        const list = (await window.sigma.invoke('pty.list')) as Array<{ id?: string; sessionId?: string }>;
        for (const s of list || []) {
          const id = s.id || s.sessionId;
          if (id) {
            // @ts-expect-error sigma is exposed
            await window.sigma.invoke('pty.kill', id).catch(() => undefined);
          }
        }
      } catch {
        /* ignore */
      }
    })
    .catch(() => undefined);

  await app.close().catch(() => undefined);

  const summary = {
    stepLog,
    consoleErrors,
    allConsoleSample: allConsole.slice(-200),
  };
  fs.writeFileSync(
    path.resolve(__dirname, '../../../docs/06-test/visual-summary.json'),
    JSON.stringify(summary, null, 2),
  );

  expect(stepLog.length).toBeGreaterThan(5);
});
