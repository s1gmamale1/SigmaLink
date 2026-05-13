// Electron main process bootstrap.
// Window lifecycle + delegate every IPC channel to the typed RPC router.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { registerRouter, shutdownRouter, getSharedDeps } from '../src/main/rpc-router';
import { maybeCheckOnBoot } from './auto-update';
import { isAllowedEvent } from '../src/shared/rpc-channels';
import {
  getCachedSnapshot,
  persistCachedSnapshot,
  readSessionSnapshot,
  rememberSessionSnapshot,
} from '../src/main/core/session/session-restore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireCJS = createRequire(import.meta.url);

let mainWindow: BrowserWindow | null = null;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// v1.0.2 — macOS shell-PATH bootstrap. When SigmaLink launches from Finder
// (DMG install), `process.env.PATH` is the truncated NSWorkspace default
// (`/usr/bin:/bin:/usr/sbin:/sbin`) — `.zshrc`/`.bash_profile` is NOT sourced.
// Provider CLIs (`claude`, `codex`, `gemini`, `cursor-agent`, `opencode`)
// almost always sit under `/opt/homebrew/bin`, `~/.npm-global/bin`,
// `~/.local/bin`, or similar — none of which appear in that default. The
// result is a packaged-app-only failure: `which claude` works in the user's
// terminal, but `node-pty.spawn('claude', …)` ENOENTs from the .app bundle.
// Fix: spawn the user's login shell once at boot in interactive mode, read
// its resolved PATH, and prepend the missing entries (dedup'd) before
// `registerRouter()` so all downstream PTYs inherit the full PATH.
//
// No-op on Win/Linux (Linux gets the user's full PATH through the launching
// terminal; Windows has its own PATH+PATHEXT resolver in `local-pty.ts`).
// Skipped when `VITE_DEV_SERVER_URL` is set (dev path already has full PATH).
//
// Source: provider-prober audit, BUG-V1.1-03-PROV (2026-05-10).
function bootstrapShellPath(): void {
  if (process.platform !== 'darwin') return;
  if (devServerUrl) return;
  const userShell = process.env.SHELL || '/bin/zsh';
  try {
    // `-i` (interactive) so .zshrc / .bash_profile is sourced; `-l` (login)
    // so /etc/profile + ~/.zprofile run too. `-c` to evaluate a single
    // statement and exit. Quoting the SHELL to handle spaces in path.
    const res = spawnSync(userShell, ['-ilc', 'printf %s "$PATH"'], {
      timeout: 3000,
      encoding: 'utf8',
      env: { ...process.env, TERM: 'dumb' }, // prevent prompt theme work
    });
    if (res.status !== 0 || !res.stdout) return;
    const shellPath = res.stdout.trim();
    if (!shellPath) return;
    const existing = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const fromShell = shellPath.split(path.delimiter).filter(Boolean);
    const seen = new Set<string>();
    const merged: string[] = [];
    // Prefer shell-resolved entries first so /opt/homebrew/bin wins over
    // the truncated /usr/bin claude.shim that Finder might also expose.
    for (const entry of [...fromShell, ...existing]) {
      if (!seen.has(entry)) {
        seen.add(entry);
        merged.push(entry);
      }
    }
    process.env.PATH = merged.join(path.delimiter);
  } catch {
    /* shell may be missing or hang — keep the truncated PATH so probe-vs-
       launch parity remains predictable rather than silently degrade */
  }
}

// v1.2.5 — synchronous Node-tooling PATH bootstrap. Even after
// `bootstrapShellPath()` succeeds we still see cases where the spawned
// shell did not expose the user's actual Node install dir (e.g. fresh
// install with no `.zshrc`, Volta/nvm not auto-sourced). The Playwright
// MCP supervisor's `npx` fallback at `playwright-supervisor.ts:167` then
// ENOENTs and the failure is invisible. This helper prepends the
// well-known Node tool dirs without spawning a shell so it is safe to run
// regardless of the user's shell config. On win32 we no-op — Windows
// applies its own PATH resolution rules and the launcher already has the
// user's full env.
export function bootstrapNodeToolPath(): void {
  if (process.platform === 'win32') return;

  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  } else if (process.platform === 'linux') {
    candidates.push('/usr/local/bin');
  }

  // Volta — single bin dir, all shims live there.
  candidates.push(path.join(home, '.volta', 'bin'));

  // nvm — one bin dir per installed Node version. Enumerate every
  // `~/.nvm/versions/node/<v>/bin` that actually exists so the supervisor's
  // `npx` shells out to the user's Node, not a stale system one.
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmRoot)) {
      const entries = fs.readdirSync(nvmRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const binDir = path.join(nvmRoot, entry.name, 'bin');
        if (fs.existsSync(binDir)) candidates.push(binDir);
      }
    }
  } catch {
    /* nvm not installed or unreadable — skip without surfacing */
  }

  const existing = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  // Prepend the candidates first so /opt/homebrew/bin/npx wins over any
  // truncated /usr/bin/npx shim that might also exist.
  for (const entry of [...candidates, ...existing]) {
    if (!entry) continue;
    if (seen.has(entry)) continue;
    // Skip non-existent candidates to keep the merged PATH lean — saves a
    // few stat calls per child-process spawn downstream.
    if (candidates.includes(entry) && !fs.existsSync(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  process.env.PATH = merged.join(path.delimiter);
}

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

  // BUG-V1.1.2-02 — once the renderer's bundle has loaded, push the persisted
  // session snapshot so AppStateProvider can dispatch SET_ACTIVE_WORKSPACE +
  // SET_ROOM. `did-finish-load` fires before React mounts; the renderer
  // queues the event on `window.sigma.eventOn(...)` from inside an effect
  // that races the IPC payload arrival — Electron buffers `send` until at
  // least one listener exists per channel, but to stay defensive we only
  // emit when a snapshot actually exists. A missing/corrupt row is silently
  // ignored so the user lands on the picker (= identical to first-run).
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      const snapshot = readSessionSnapshot();
      if (snapshot && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:session-restore', snapshot);
      }
    } catch {
      /* never block boot on session restore */
    }
  });

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

// v1.1.1 — single-instance lock. Without this, double-clicking the .app a
// second time, or any LaunchServices activation while SigmaLink is already
// running (some agent CLIs registering URL handlers, drag-drops onto the
// dock icon, OS reauth flows), spawns a parallel instance with its own
// SQLite handle, its own PTY pool, its own rcps. The duplicate instance
// fights the original for the WAL lock and the user sees two SigmaLink
// icons in the dock. Acquire the lock; if we lose it, focus the existing
// window and quit cleanly.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// BUG-V1.1.2-02 — Renderer pushes `app:session-snapshot { workspaceId, room }`
// every time the active workspace or room changes (throttled to ≤ 1/sec).
// `rememberSessionSnapshot` runs the zod schema on the payload and silently
// drops anything malformed so a compromised renderer can't poison the kv
// row. The kv write itself happens once from `before-quit` so we don't
// thrash the WAL during a normal session. The `isAllowedEvent` guard is
// defence-in-depth: the channel is already in the allowlist or this main
// process would never have registered the listener at all.
ipcMain.on('app:session-snapshot', (_event, payload: unknown) => {
  if (!isAllowedEvent('app:session-snapshot')) return;
  rememberSessionSnapshot(payload);
});

void app.whenReady().then(() => {
  // BUG-V1.1-03-PROV — pull the user's interactive-shell PATH into the main
  // process before any provider PTY spawns, so DMG-launched apps can find
  // /opt/homebrew/bin/claude etc. No-op on Win/Linux + dev server.
  bootstrapShellPath();

  // v1.2.5 — synchronous Node-tool PATH augmentation. Belt-and-braces to
  // `bootstrapShellPath()`: makes sure `/opt/homebrew/bin`, Volta, and
  // every installed nvm Node bin dir are on PATH before the Playwright
  // MCP supervisor's `npx @playwright/mcp` fallback spawns.
  bootstrapNodeToolPath();

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
//
// BUG-V1.1.2-02 — Persist the renderer's last-known workspace + room BEFORE
// shutting the router down: the kv write runs through `getRawDb()` and that
// handle gets closed inside `shutdownRouter` → `closeDatabase()`. A flush
// after the close would be a no-op. The renderer may already be torn down
// at this point, so we cannot ask it for the snapshot — we rely on the
// cached value seeded by `app:session-snapshot` IPC events during the run.
app.on('before-quit', () => {
  try {
    if (getCachedSnapshot()) {
      persistCachedSnapshot();
    }
  } catch {
    /* never let session persistence block shutdown */
  }
  shutdownRouter();
});
