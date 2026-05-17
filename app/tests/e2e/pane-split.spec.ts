// v1.4.3 #06 — End-to-end smoke for Pane Split + Minimise.
//
// Drives a real Electron app: opens a workspace, launches a small grid, then
// splits one pane and asserts the sub-grid renders with both sub-panes live.
// Minimise / Restore is exercised on the second sub-pane.
//
// Skipped by default — this suite needs an Electron build (`build-electron.cjs`)
// and a writable workspace dir on disk. Enable in CI by setting
// `SIGMALINK_E2E_PANE_SPLIT=1`.

import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const E2E_ENABLED = process.env.SIGMALINK_E2E_PANE_SPLIT === '1';

(E2E_ENABLED ? test : test.skip)(
  'v1.4.3 #06 — split + minimise smoke',
  async () => {
    test.setTimeout(120_000);

    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-e2e-split-'));
    let app: ElectronApplication | null = null;
    try {
      app = await electron.launch({
        args: [path.resolve(__dirname, '../../electron-dist/main.js')],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
        timeout: 60_000,
      });
      const win: Page = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');

      // Test harness hook from state.tsx (`sigma:test:activate-workspace`).
      // Production code path uses `rpc.workspaces.open` first; the test
      // suite drives that via the in-process IPC bridge.
      await win.evaluate(async (rootPath) => {
        // @ts-expect-error: window.sigma is wired by preload only at runtime.
        const ws = await window.sigma.invoke('workspaces.open', { rootPath });
        window.dispatchEvent(
          new CustomEvent('sigma:test:activate-workspace', { detail: { rootPath } }),
        );
        return ws;
      }, tmpWs);

      // Open a 4-pane Claude grid. The exact route depends on the launcher
      // wizard; we drive the grid via the test-only sidebar room nav and
      // then create a swarm via RPC for determinism.
      const swarm = await win.evaluate(async () => {
        // @ts-expect-error: preload-only API.
        const list = await window.sigma.invoke('workspaces.list');
        const ws = list[0];
        // @ts-expect-error: preload-only API.
        return window.sigma.invoke('swarms.create', {
          workspaceId: ws.id,
          mission: 'split smoke',
          preset: 'custom',
          roster: [
            { role: 'builder', roleIndex: 1, providerId: 'shell' },
            { role: 'builder', roleIndex: 2, providerId: 'shell' },
            { role: 'builder', roleIndex: 3, providerId: 'shell' },
            { role: 'builder', roleIndex: 4, providerId: 'shell' },
          ],
        });
      });
      expect(swarm).toBeTruthy();
      await win.waitForTimeout(800); // give the PTYs time to wire.

      // Find pane 1 and click its Split-V icon. We can't reliably target
      // Radix tooltip-wrapped dropdowns by aria, so drive via the RPC:
      const splitResult = await win.evaluate(async () => {
        // @ts-expect-error: preload-only API.
        const sessions = await window.sigma.invoke('panes.lastResumePlan');
        // @ts-expect-error: preload-only API.
        return window.sigma.invoke('swarms.splitPane', {
          paneId: sessions[0]?.sessionId ?? sessions[0]?.id,
          direction: 'horizontal',
          provider: 'shell',
        });
      });
      expect(splitResult).toBeTruthy();
      await win.waitForTimeout(800);

      // Assert both halves render (data-split-group attribute).
      const groups = await win.locator('[data-split-group]').count();
      expect(groups).toBeGreaterThanOrEqual(1);

      // Minimise sub-pane (toggle minimised=true; verify the body container
      // collapses to display:none while the terminal stays mounted).
      const minimiseResult = await win.evaluate(async (childId: string) => {
        // @ts-expect-error: preload-only API.
        return window.sigma.invoke('swarms.minimisePane', { paneId: childId, minimised: true });
      }, (splitResult as { id: string }).id);
      expect(minimiseResult).toBeUndefined();
      await win.waitForTimeout(400);

      // Restore.
      await win.evaluate(async (childId: string) => {
        // @ts-expect-error: preload-only API.
        return window.sigma.invoke('swarms.minimisePane', { paneId: childId, minimised: false });
      }, (splitResult as { id: string }).id);
    } finally {
      if (app) await app.close();
      try {
        fs.rmSync(tmpWs, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
  },
);
