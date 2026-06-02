import { test, _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainPath = path.resolve(__dirname, '../../electron-dist/main.js');

const tmpDirs: string[] = [];

interface SigmaWindow extends Window {
  sigma: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Robustly remove a temp directory, tolerating a transient npm/_cacache
 * writer (e.g. a spawned npx daemon) that may still be flushing after the
 * Electron app is closed.  Strategy:
 *   1. fs.promises.rm with recursive+force+maxRetries so the OS retry loop
 *      handles the ENOTEMPTY race without surfacing it to the test runner.
 *   2. If all retries exhaust (extremely unlikely), log a warning and
 *      continue — stale temp dirs in /var/folders are cleaned by macOS on
 *      reboot and must never fail a CI run.
 */
async function removeTmpDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (err) {
    // Non-fatal: log and move on.  A leftover temp dir should not fail CI.
    console.warn(`[ruflo-autowrite] teardown: could not remove ${dir}: ${(err as NodeJS.ErrnoException).message}`);
  }
}

test.afterEach(async () => {
  // Drain: give any grandchild npm/npx subprocesses spawned by the Electron
  // app (e.g. the ruflo MCP daemon started via mcp-autowrite) a moment to
  // finish their last write before we try to remove the temp HOME directory.
  // 300 ms is enough for npm's cache flush on macOS; the retry loop in
  // removeTmpDir handles anything that slips through.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  while (tmpDirs.length > 0) {
    await removeTmpDir(tmpDirs.pop()!);
  }
});

test('opening a workspace writes a Ruflo MCP entry', async () => {
  test.setTimeout(90_000);

  if (!fs.existsSync(mainPath)) {
    test.skip(true, 'electron-dist/main.js not built');
    return;
  }

  const userDataDir = tmpDir('sigmalink-ruflo-userdata-');
  const fakeHome = tmpDir('sigmalink-ruflo-home-');
  const workspaceRoot = tmpDir('sigmalink-ruflo-workspace-');
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: [mainPath, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        NODE_ENV: 'test',
        SIGMA_TEST: '1',
        HOME: fakeHome,
      },
      timeout: 60_000,
    });

    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded').catch(() => undefined);
    await win.evaluate(async (root) => {
      const sigma = (window as SigmaWindow).sigma;
      await sigma.invoke('kv.set', 'app.onboarded', '1');
      await sigma.invoke('kv.set', 'coachmark.featureSpotlight.seen', '1');
      await sigma.invoke('workspaces.open', root);
    }, workspaceRoot);

    const claudeConfigPath = path.join(workspaceRoot, '.mcp.json');
    await expect
      .poll(() => fs.existsSync(claudeConfigPath), { timeout: 5_000 })
      .toBe(true);
    const config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
    // v1.3.5 canonical-args fix: 'mcp-stdio' was never a real claude-flow
    // subcommand. The correct form is ['-y', '@claude-flow/cli@latest', 'mcp', 'start'].
    // Pre-existing user configs self-heal on the next openWorkspace() call.
    expect(config.mcpServers.ruflo).toEqual({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
      env: { CLAUDE_FLOW_DIR: path.join(workspaceRoot, '.claude-flow') },
    });
  } finally {
    await app?.close().catch(() => undefined);
  }
});
