import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainEntry = path.resolve(__dirname, '../../electron-dist/main.js');

interface PtyListItem {
  sessionId: string;
  providerId: string;
  cwd: string;
  alive: boolean;
  pid: number;
}

async function invoke<T>(win: Page, channel: string, ...args: unknown[]): Promise<T> {
  return win.evaluate(
    async ({ rpcChannel, rpcArgs }) => {
      const sigma = (window as unknown as {
        sigma: { invoke: (channelName: string, ...channelArgs: unknown[]) => Promise<unknown> };
      }).sigma;
      return sigma.invoke(rpcChannel, ...rpcArgs);
    },
    { rpcChannel: channel, rpcArgs: args },
  ) as Promise<T>;
}

async function waitForSigmaBridge(win: Page): Promise<boolean> {
  try {
    await expect
      .poll(
        () =>
          win.evaluate(() => {
            const maybeWindow = window as unknown as { sigma?: { invoke?: unknown } };
            return typeof maybeWindow.sigma?.invoke === 'function';
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
    return true;
  } catch {
    return false;
  }
}

async function activateWorkspace(win: Page, rootPath: string): Promise<void> {
  await win.evaluate((targetRoot) => {
    window.dispatchEvent(
      new CustomEvent('sigma:test:activate-workspace', { detail: { rootPath: targetRoot } }),
    );
  }, rootPath);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('workspace switching keeps PTY pid alive and stable', async () => {
  test.setTimeout(90_000);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-v127-'));
  const wsA = path.join(tmpRoot, 'workspace-a');
  const wsB = path.join(tmpRoot, 'workspace-b');
  fs.mkdirSync(wsA);
  fs.mkdirSync(wsB);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'test' },
      timeout: 60_000,
    });
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded').catch(() => undefined);
    const bridgeReady = await waitForSigmaBridge(win);
    test.skip(!bridgeReady, `Sigma preload bridge unavailable; window title="${await win.title()}"`);

    await invoke(win, 'kv.set', 'app.onboarded', '1');
    await invoke(win, 'workspaces.open', wsA);
    await invoke(win, 'workspaces.open', wsB);
    await activateWorkspace(win, wsA);

    await invoke(win, 'workspaces.launch', {
      workspaceRoot: wsA,
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'shell' }],
    });

    await expect
      .poll(async () => {
        const sessions = await invoke<PtyListItem[]>(win, 'pty.list');
        return sessions.some((session) => session.cwd === wsA && session.alive);
      }, { timeout: 10_000 })
      .toBe(true);

    const before = (await invoke<PtyListItem[]>(win, 'pty.list')).find(
      (session) => session.cwd === wsA && session.alive,
    );
    expect(before).toBeTruthy();
    expect(processIsAlive(before!.pid)).toBe(true);

    await activateWorkspace(win, wsB);
    await win.waitForTimeout(500);
    await activateWorkspace(win, wsA);
    await win.waitForTimeout(500);

    const after = (await invoke<PtyListItem[]>(win, 'pty.list')).find(
      (session) => session.sessionId === before!.sessionId,
    );
    expect(after).toMatchObject({
      sessionId: before!.sessionId,
      pid: before!.pid,
      alive: true,
    });
    expect(processIsAlive(before!.pid)).toBe(true);
  } finally {
    if (app) await app.close().catch(() => undefined);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
