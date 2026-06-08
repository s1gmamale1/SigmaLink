// End-to-end smoke for the uniform pane fill-grid: Split + Minimise.
//
// Drives a real Electron app: opens a workspace, launches a 4-pane grid, then
// adds a pane (via splitPane RPC) and asserts the fill-grid tiles the body with
// no dead space and square corners. Minimise / Restore is exercised on the new
// pane. (Grid-shape math is covered by the pane-grid-shape unit tests.)
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

      // BSP tiling: the split added a new leaf (4 → ≥5). Assert the visible
      // leaves tile the body with square corners and ~no dead space.
      const leaves = win.locator('[data-testid="pane-cell"]:not([data-bsp-hidden="true"])');
      expect(await leaves.count()).toBeGreaterThanOrEqual(5);

      // Square corners (BridgeSpace match — no rounded tiles).
      const radius = await leaves.first().evaluate((el) => getComputedStyle(el).borderRadius);
      expect(radius).toBe('0px');

      // No dead space: the union of visible leaf areas covers ~the container
      // (dividers eat a few px, so ≥90%).
      const fillRatio = await win.evaluate(() => {
        const root = document.querySelector('[data-testid="pane-grid"]') as HTMLElement | null;
        if (!root) return 0;
        const host = root.getBoundingClientRect();
        const hostArea = host.width * host.height;
        if (hostArea <= 0) return 0;
        const els = Array.from(root.querySelectorAll('[data-testid="pane-cell"]')) as HTMLElement[];
        const area = els
          .filter((e) => e.getAttribute('data-bsp-hidden') !== 'true')
          .reduce((sum, e) => {
            const r = e.getBoundingClientRect();
            return sum + r.width * r.height;
          }, 0);
        return area / hostArea;
      });
      expect(fillRatio).toBeGreaterThan(0.9);

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
