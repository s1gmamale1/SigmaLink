// Real Electron smoke for workspace-scoped Command Room pane reordering.
//
// The suite is opt-in because it launches live shell PTYs and needs a compiled
// Electron entry point. Enable it with `SIGMALINK_E2E_PANE_REORDER=1` after
// running `pnpm build && pnpm electron:compile`.

import {
  test,
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainEntry = path.resolve(__dirname, '../../electron-dist/main.js');
const enabled = process.env.SIGMALINK_E2E_PANE_REORDER === '1';
const paneCounts = [3, 5, 7, 12] as const;

interface WorkspaceRow {
  id: string;
  rootPath: string;
}

interface SwarmRow {
  id: string;
  agents: Array<{ sessionId: string | null }>;
}

interface PaneOrderRecord {
  version: number;
  sessionIds: string[];
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

async function invoke<T>(win: Page, channel: string, ...args: unknown[]): Promise<T> {
  const raw = await win.evaluate(
    async ({ rpcChannel, rpcArgs }) => {
      const sigma = (window as unknown as {
        sigma: { invoke: (name: string, ...args: unknown[]) => Promise<unknown> };
      }).sigma;
      return sigma.invoke(rpcChannel, ...rpcArgs);
    },
    { rpcChannel: channel, rpcArgs: args },
  );

  if (raw && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)) {
    const envelope = raw as { ok: boolean; data?: unknown; error?: string };
    if (envelope.ok) return envelope.data as T;
    throw new Error(envelope.error ?? `${channel} failed`);
  }
  return raw as T;
}

async function waitForSigmaBridge(win: Page): Promise<void> {
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const candidate = window as unknown as { sigma?: { invoke?: unknown } };
          return typeof candidate.sigma?.invoke === 'function';
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function waitForRendererTestHooks(win: Page): Promise<void> {
  await expect
    .poll(
      () =>
        win.evaluate(
          () => document.documentElement.dataset.sigmaTestStateHooksReady,
        ),
      { timeout: 15_000 },
    )
    .toBe('true');
}

async function activateCommandRoom(win: Page, workspace: WorkspaceRow): Promise<void> {
  await waitForRendererTestHooks(win);
  await win.evaluate(({ id, rootPath }) => {
    window.dispatchEvent(
      new CustomEvent('sigma:test:activate-workspace', { detail: { id, rootPath } }),
    );
    window.dispatchEvent(
      new CustomEvent('sigma:test:set-room', { detail: { room: 'command' } }),
    );
  }, workspace);

  // Observe the exact async activation + room transition in committed React
  // state. Only then ask the active-workspace-bound reload hook to run.
  await expect
    .poll(() =>
      win.evaluate(() => ({
        workspaceId:
          document.documentElement.dataset.sigmaTestActiveWorkspaceId,
        room: document.documentElement.dataset.sigmaTestRoom,
      })),
    )
    .toEqual({ workspaceId: workspace.id, room: 'command' });
  await win.evaluate(() => {
    window.dispatchEvent(new CustomEvent('sigma:test:reload-sessions'));
  });
}

async function cleanupRun(
  app: ElectronApplication | null,
  tmpRoot: string,
  bodyFailed: boolean,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    if (app) await app.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length === 0) return;
  const cleanupFailure = new AggregateError(
    cleanupErrors,
    `pane reorder cleanup failed for ${tmpRoot}`,
  );
  if (bodyFailed) {
    console.error('[pane-reorder] cleanup failed after test failure', cleanupFailure);
    return;
  }
  throw cleanupFailure;
}

async function visualOrder(win: Page): Promise<string[]> {
  return win.locator('[data-testid="pane-cell"]').evaluateAll((cells) =>
    cells.map((cell) => cell.getAttribute('data-session-id') ?? ''),
  );
}

function swapped(order: string[], sourceIndex: number, targetIndex: number): string[] {
  const next = [...order];
  [next[sourceIndex], next[targetIndex]] = [next[targetIndex]!, next[sourceIndex]!];
  return next;
}

async function dragPointer(source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox, 'reorder grip has a pointer target').not.toBeNull();
  expect(targetBox, 'pane cell has a pointer target').not.toBeNull();
  if (!sourceBox || !targetBox) return;

  const page = source.page();
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX - 8, sourceY, { steps: 2 });
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();
}

async function resizeFirstDivider(win: Page): Promise<void> {
  const divider = win.locator('[data-testid="pane-divider"][data-orientation="vertical"]').first();
  const dividerBox = await divider.boundingBox();
  expect(dividerBox, 'a multi-pane row exposes a vertical divider').not.toBeNull();
  if (!dividerBox) return;

  const leftCell = win.locator('[data-testid="pane-cell"]').first();
  const before = await leftCell.boundingBox();
  expect(before).not.toBeNull();
  if (!before) return;

  const x = dividerBox.x + dividerBox.width / 2;
  const y = dividerBox.y + dividerBox.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + Math.min(40, before.width * 0.1), y, { steps: 6 });
  await win.mouse.up();

  await expect
    .poll(async () => (await leftCell.boundingBox())?.width ?? 0)
    .not.toBeCloseTo(before.width, 0);
}

async function assertGridGeometry(win: Page, paneCount: number): Promise<void> {
  const result = await win.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-testid="pane-grid"]');
    if (!grid) return null;
    const gridRect = grid.getBoundingClientRect();
    const cells = Array.from(
      grid.querySelectorAll<HTMLElement>('[data-testid="pane-cell"]'),
    ).filter((cell) => cell.getAttribute('data-bsp-hidden') !== 'true');
    const rects: Rect[] = cells.map((cell) => {
      const rect = cell.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    });
    const clippedVisibleArea = rects.reduce((total, rect) => {
      const width = Math.max(
        0,
        Math.min(rect.right, gridRect.right) - Math.max(rect.left, gridRect.left),
      );
      const height = Math.max(
        0,
        Math.min(rect.bottom, gridRect.bottom) - Math.max(rect.top, gridRect.top),
      );
      return total + width * height;
    }, 0);
    const gridArea = gridRect.width * gridRect.height;
    return {
      gridRect: {
        left: gridRect.left,
        right: gridRect.right,
        top: gridRect.top,
        bottom: gridRect.bottom,
        width: gridRect.width,
        height: gridRect.height,
      },
      clippedFillRatio: gridArea > 0 ? clippedVisibleArea / gridArea : 0,
      radii: cells.map((cell) => getComputedStyle(cell).borderRadius),
      rects,
    };
  });

  expect(result, 'pane grid is mounted').not.toBeNull();
  if (!result) return;
  expect(result.gridRect.width).toBeGreaterThan(0);
  expect(result.gridRect.height).toBeGreaterThan(0);
  expect(result.rects).toHaveLength(paneCount);
  expect(result.clippedFillRatio).toBeGreaterThanOrEqual(0.9);
  expect(result.radii).toEqual(Array.from({ length: paneCount }, () => '0px'));

  const containmentTolerance = 1;
  for (const [index, rect] of result.rects.entries()) {
    expect(
      rect.left >= result.gridRect.left - containmentTolerance
        && rect.right <= result.gridRect.right + containmentTolerance
        && rect.top >= result.gridRect.top - containmentTolerance
        && rect.bottom <= result.gridRect.bottom + containmentTolerance,
      `pane rectangle ${index + 1} stays inside the pane grid`,
    ).toBe(true);
  }

  for (let left = 0; left < result.rects.length; left += 1) {
    for (let right = left + 1; right < result.rects.length; right += 1) {
      const a = result.rects[left]!;
      const b = result.rects[right]!;
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(
        overlapWidth > 0.5 && overlapHeight > 0.5,
        `pane rectangles ${left + 1} and ${right + 1} do not overlap`,
      ).toBe(false);
    }
  }
}

for (const paneCount of paneCounts) {
  (enabled ? test : test.skip)(
    `persisted pointer and keyboard pane swap — ${paneCount} panes`,
    async () => {
      test.setTimeout(180_000);
      const tmpRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `sigmalink-e2e-pane-reorder-${paneCount}-`),
      );
      const userDataDir = path.join(tmpRoot, 'user-data');
      const workspaceRoot = path.join(tmpRoot, 'workspace');

      let app: ElectronApplication | null = null;
      let bodyFailed = false;
      try {
        fs.mkdirSync(userDataDir);
        fs.mkdirSync(workspaceRoot);
        expect(fs.existsSync(mainEntry), 'electron-dist/main.js is built').toBe(true);
        app = await electron.launch({
          args: [mainEntry, `--user-data-dir=${userDataDir}`],
          env: {
            ...process.env,
            ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
            NODE_ENV: 'test',
            SIGMA_TEST: '1',
          },
          timeout: 60_000,
        });
        const win = await app.firstWindow({ timeout: 30_000 });
        await win.waitForLoadState('domcontentloaded').catch(() => undefined);
        await waitForSigmaBridge(win);

        // Persist first-run gates before any workspace or pane is mounted, then
        // reload so the renderer hydrates those gates through its production KV path.
        await invoke(win, 'kv.set', 'app.onboarded', '1');
        await invoke(win, 'kv.set', 'coachmark.featureSpotlight.seen', '1');
        await win.reload();
        await waitForSigmaBridge(win);

        const workspace = await invoke<WorkspaceRow>(
          win,
          'workspaces.open',
          workspaceRoot,
        );
        await activateCommandRoom(win, workspace);
        const swarm = await invoke<SwarmRow>(win, 'swarms.create', {
          workspaceId: workspace.id,
          mission: `pane reorder smoke ${paneCount}`,
          preset: 'custom',
          forceRamBrake: true,
          roster: Array.from({ length: paneCount }, (_, index) => ({
            role: 'builder',
            roleIndex: index + 1,
            providerId: 'shell',
          })),
        });
        expect(swarm.agents.map((agent) => agent.sessionId).filter(Boolean)).toHaveLength(
          paneCount,
        );
        await activateCommandRoom(win, workspace);

        const cells = win.locator('[data-testid="pane-cell"]');
        await expect(cells).toHaveCount(paneCount, { timeout: 20_000 });
        const initialOrder = await visualOrder(win);
        expect(initialOrder.every(Boolean)).toBe(true);

        await resizeFirstDivider(win);

        const sourceId = initialOrder.at(-1)!;
        const targetId = initialOrder[0]!;
        const sourceGrip = win.locator(
          `[data-pane-reorder-handle][data-session-id="${sourceId}"]`,
        );
        const targetCell = win.locator(
          `[data-testid="pane-cell"][data-session-id="${targetId}"]`,
        );
        await dragPointer(sourceGrip, targetCell);

        const pointerOrder = swapped(initialOrder, paneCount - 1, 0);
        await expect.poll(() => visualOrder(win)).toEqual(pointerOrder);
        await assertGridGeometry(win, paneCount);

        const marker = `SIGMALINK_REORDER_${paneCount}_${Date.now()}`;
        const movedCell = win.locator(
          `[data-testid="pane-cell"][data-session-id="${sourceId}"]`,
        );
        const terminalInput = movedCell.locator('textarea[aria-label="terminal input"]');
        await expect(terminalInput).toHaveCount(1);
        await terminalInput.evaluate((input: HTMLTextAreaElement) => input.focus());
        await win.keyboard.type(`printf '${marker}\\n'`);
        await win.keyboard.press('Enter');
        await expect(movedCell).toContainText(marker, { timeout: 10_000 });

        const orderKey = `ui.${workspace.id}.commandRoom.paneOrder`;
        await expect
          .poll(async () => invoke<string | null>(win, 'kv.get', orderKey))
          .not.toBeNull();
        const pointerRecord = JSON.parse(
          (await invoke<string>(win, 'kv.get', orderKey)),
        ) as PaneOrderRecord;
        expect(pointerRecord).toEqual({ version: 1, sessionIds: pointerOrder });

        // Reload the real renderer, reactivate the same workspace, and prove
        // the versioned order record wins over canonical pane_index order.
        await win.reload();
        await waitForSigmaBridge(win);
        await activateCommandRoom(win, workspace);
        await expect(cells).toHaveCount(paneCount, { timeout: 20_000 });
        await expect.poll(() => visualOrder(win)).toEqual(pointerOrder);

        const keyboardSourceId = pointerOrder[0]!;
        const keyboardTargetId = pointerOrder[1]!;
        const keyboardGrip = win.locator(
          `[data-pane-reorder-handle][data-session-id="${keyboardSourceId}"]`,
        );
        await keyboardGrip.focus();
        await keyboardGrip.press('Space');
        await expect(win.getByTestId('pane-reorder-overlay')).toBeVisible();
        await win.keyboard.press('ArrowRight');
        await expect
          .poll(() => win.locator('[role="status"]').allTextContents())
          .toContainEqual(
            expect.stringContaining(
              `will swap with position 2 of ${paneCount}`,
            ),
          );
        await win.keyboard.press('Space');

        const keyboardOrder = swapped(pointerOrder, 0, 1);
        await expect.poll(() => visualOrder(win)).toEqual(keyboardOrder);
        const keyboardRecord = JSON.parse(
          (await invoke<string>(win, 'kv.get', orderKey)),
        ) as PaneOrderRecord;
        expect(keyboardRecord).toEqual({ version: 1, sessionIds: keyboardOrder });
        await expect(
          win.locator(
            `[data-pane-reorder-handle][data-session-id="${keyboardSourceId}"]`,
          ),
        ).toBeFocused();
        expect(keyboardTargetId).toBe(keyboardOrder[0]);
        await expect(win.getByTestId('pane-reorder-overlay')).toHaveCount(0);

        const cancelOrder = await visualOrder(win);
        const cancelGrip = win.locator(
          `[data-pane-reorder-handle][data-session-id="${cancelOrder[0]}"]`,
        );
        await cancelGrip.focus();
        await cancelGrip.press('Space');
        await expect(win.getByTestId('pane-reorder-overlay')).toBeVisible();
        await win.keyboard.press('ArrowRight');
        await win.keyboard.press('Escape');
        await expect(win.getByTestId('pane-reorder-overlay')).toHaveCount(0);
        await expect.poll(() => visualOrder(win)).toEqual(cancelOrder);
        await expect
          .poll(() => win.locator('[role="status"]').allTextContents())
          .toContainEqual(expect.stringContaining('Pane move cancelled.'));
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        await cleanupRun(app, tmpRoot, bodyFailed);
      }
    },
  );
}
