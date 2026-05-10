// Electron main process bootstrap.
// Window lifecycle + delegate every IPC channel to the typed RPC router.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { app, BrowserWindow, shell } from 'electron';
import { registerRouter, shutdownRouter, getSharedDeps } from '../src/main/rpc-router';
import { maybeCheckOnBoot } from './auto-update';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireCJS = createRequire(import.meta.url);

let mainWindow: BrowserWindow | null = null;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Native-module self-check. Catches the dominant install-time failure mode:
// `better-sqlite3` or `node-pty` ABI mismatch after upgrading Electron without
// a rebuild, or a partial `npm install` that left `.bin/` empty. Without this
// guard, the renderer just shows a white screen because the RPC router
// throws on first DB open.
interface NativeModuleCheck {
  readonly module: string;
  readonly ok: boolean;
  readonly error?: string;
}

// v1.0.1 — real instantiation, not just `require()`. The v1.0.0 DMG passed
// `requireCJS('better-sqlite3')` (which only loads `database.js`) but blew up
// at first `new Database(...)` because the inner `require('bindings')` was
// dropped from the asar. Spinning up an in-memory DB and a 1×1 PTY here
// triggers the full native-loader chain at boot, so any packaging defect
// surfaces in the diagnostic window instead of a white-screen renderer.
function checkNativeModules(): NativeModuleCheck[] {
  const probes: ReadonlyArray<{ module: string; probe: () => void }> = [
    {
      module: 'better-sqlite3',
      probe: () => {
        const Database = requireCJS('better-sqlite3') as new (path: string) => {
          prepare: (sql: string) => { get: () => unknown };
          close: () => void;
        };
        const db = new Database(':memory:');
        try {
          db.prepare('SELECT 1').get();
        } finally {
          db.close();
        }
      },
    },
    {
      module: 'node-pty',
      probe: () => {
        const pty = requireCJS('node-pty') as {
          spawn: (
            shell: string,
            args: ReadonlyArray<string>,
            opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
          ) => { kill: () => void };
        };
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const term = pty.spawn(shell, [], {
          name: 'xterm-color',
          cols: 1,
          rows: 1,
          cwd: process.cwd(),
          env: process.env,
        });
        term.kill();
      },
    },
  ];
  return probes.map(({ module, probe }) => {
    try {
      probe();
      return { module, ok: true };
    } catch (err) {
      return { module, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function buildDiagnosticHtml(checks: NativeModuleCheck[]): string {
  const failures = checks.filter((c) => !c.ok);
  const versions = {
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node,
    chrome: process.versions.chrome ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
  };
  const failureRows = failures
    .map(
      (f) =>
        `<tr><td><code>${escapeHtml(f.module)}</code></td><td><pre>${escapeHtml(f.error ?? '')}</pre></td></tr>`,
    )
    .join('');
  const rebuildCmd =
    process.platform === 'win32'
      ? 'cd app && npx electron-rebuild -f -w better-sqlite3 -w node-pty'
      : 'cd app && npx electron-rebuild -f -w better-sqlite3 -w node-pty';
  return `<!doctype html><html><head><meta charset="utf-8"><title>SigmaLink — Native Module Mismatch</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; background: #0a0c12; color: #d8dde6; margin: 0; padding: 32px; }
  h1 { color: #ff8a73; margin: 0 0 16px; }
  h2 { color: #c1cad6; font-size: 15px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  td { vertical-align: top; padding: 8px 12px; border-top: 1px solid #1f2532; font-size: 13px; }
  td:first-child { width: 22%; white-space: nowrap; }
  pre { white-space: pre-wrap; margin: 0; font: 12px ui-monospace, Consolas, monospace; color: #ffb29a; }
  code { font: 12px ui-monospace, Consolas, monospace; color: #92d8ff; }
  .cmd { background: #11151f; border: 1px solid #1f2532; border-radius: 6px; padding: 10px 14px; user-select: all; }
  .meta { color: #6e7889; font-size: 12px; }
  .row { display: flex; gap: 24px; flex-wrap: wrap; }
  .row > div { min-width: 180px; }
</style></head><body>
<h1>Native module mismatch</h1>
<p>The Electron build cannot load required native modules. The app cannot start until these are rebuilt against the current Electron binary.</p>
<h2>Failures</h2>
<table>${failureRows}</table>
<h2>Fix it</h2>
<p>Run from the repository root:</p>
<div class="cmd"><code>${escapeHtml(rebuildCmd)}</code></div>
<p>If <code>node_modules</code> is empty or partial, run <code>npm install</code> first.</p>
<h2>Environment</h2>
<div class="row">
  <div class="meta">Electron <code>${escapeHtml(versions.electron)}</code></div>
  <div class="meta">Node <code>${escapeHtml(versions.node)}</code></div>
  <div class="meta">Chrome <code>${escapeHtml(versions.chrome)}</code></div>
  <div class="meta">Platform <code>${escapeHtml(versions.platform)}</code></div>
  <div class="meta">Arch <code>${escapeHtml(versions.arch)}</code></div>
</div>
</body></html>`;
}

function showDiagnosticWindow(checks: NativeModuleCheck[]): void {
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    title: 'SigmaLink — Diagnostic',
    backgroundColor: '#0a0c12',
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDiagnosticHtml(checks))}`);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1024,
    minHeight: 660,
    title: 'SigmaLink',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0c12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // V3-W14-009 — re-run the native-module probe once the renderer is
    // listening. The boot self-check above already gates the dominant
    // failure mode (ABI mismatch on cold start), but a `pnpm install` that
    // races with the running Electron can leave native modules half-
    // loaded; emitting here lets the renderer surface NativeRebuildModal
    // without a restart in those edge cases.
    try {
      const recheck = checkNativeModules();
      const failed = recheck.filter((c) => !c.ok);
      if (failed.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:native-rebuild-needed', {
          modules: failed.map((f) => ({ module: f.module, error: f.error })),
        });
      }
    } catch {
      /* never block window-show on the recheck */
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    // Tear down any per-workspace BrowserManagers that were attached to this
    // window so their child WebContentsViews don't outlive the parent and
    // their Playwright MCP supervisors are stopped.
    try {
      getSharedDeps()?.browserRegistry.teardownAll();
    } catch {
      /* ignore */
    }
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  const checks = checkNativeModules();
  if (checks.some((c) => !c.ok)) {
    showDiagnosticWindow(checks);
    return;
  }
  registerRouter();
  createWindow();
  // V3-W14-008 — kick off auto-update check on boot when the user has opted
  // in. The kv flag is checked inside `maybeCheckOnBoot()` so the call is
  // safe even on first install where no kv row exists yet.
  try {
    maybeCheckOnBoot();
  } catch {
    /* never block boot on update plumbing */
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Graceful shutdown: kill live PTYs, flush + close SQLite WAL. Without this,
// surviving sessions are left "running" in the DB and unfinalised WAL pages
// linger on disk. `before-quit` may fire on macOS even when windows remain.
app.on('before-quit', () => {
  shutdownRouter();
});
