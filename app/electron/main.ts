// Electron main process bootstrap.
// Window lifecycle + delegate every IPC channel to the typed RPC router.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, nativeImage, clipboard } from 'electron';
import { buildGlobalCaptureController, getWhisperEngine, type GlobalCaptureController } from '@sigmalink/voice-core';
import { registerRouter, shutdownRouter, getSharedDeps } from '../src/main/rpc-router';
import { getRawDb } from '../src/main/core/db/client';
// C-11 "Hey Sigma" listening-mode primitives (pure, shared).
import { PcmRing } from '../src/shared/pcm-ring';
import { isSpeech as energyIsSpeech } from '../src/shared/audio-energy';
import { matchesWakeWord as wakeMatch } from '../src/shared/wake-word';
import { getModelById as getVoiceModelById, getDownloadedModelPath as getDownloadedVoiceModelPath } from '../src/main/core/voice/model-registry';
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

// v1.5.0 — Global voice capture: Tray + globalShortcut + state controller.
// The Tray keeps the process alive on all platforms when the last window
// closes and global capture is enabled (overrides window-all-closed quit
// logic below). macOS shipped in v1.4.9; Windows + Linux fan-out in v1.5.0.
let tray: Tray | null = null;
let globalCaptureCtrl: GlobalCaptureController | null = null;

/**
 * Build or rebuild the Tray context menu based on current capture state.
 * Called after any capture state change.
 */
function updateTrayMenu(): void {
  if (!tray) return;
  const ctrl = globalCaptureCtrl;
  const status = ctrl?.getStatus();
  const isEnabled = status?.enabled ?? false;
  const captureState = status?.state ?? 'idle';
  const isRecording = captureState === 'recording';

  const menu = Menu.buildFromTemplate([
    {
      label: isRecording ? 'Stop recording' : (isEnabled ? 'Start recording' : 'Global capture (disabled)'),
      enabled: isEnabled,
      click: () => {
        if (!ctrl) return;
        if (isRecording) {
          void ctrl.stopAndTranscribe();
        } else {
          void ctrl.startRecording();
        }
      },
    },
    { type: 'separator' },
    {
      label: isEnabled ? 'Disable global capture' : 'Enable global capture',
      click: () => ctrl?.setEnabled(!isEnabled),
    },
    {
      label: 'Open Settings → Voice',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('app:navigate', { pane: 'settings', tab: 'voice' });
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit SigmaLink',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(menu);
  // Reflect recording state in the tooltip
  tray.setToolTip(
    isRecording
      ? 'SigmaLink — Recording…'
      : isEnabled
        ? 'SigmaLink Voice (ready)'
        : 'SigmaLink',
  );
}

/**
 * Initialise the Tray icon for macOS, Windows, and Linux.
 * Extended in v1.5.0 from macOS-only (v1.4.9) to all desktop platforms.
 *
 * Icon notes:
 *   macOS   — template image (monochrome, auto-inverts for light/dark bar)
 *   Windows — 16×16 or 32×32 ICO/PNG; taskbar notification area
 *   Linux   — 22×22 PNG typical for system tray via libappindicator / StatusNotifier
 *
 * In production, replace the placeholder icon with a proper per-platform asset.
 */
function initTray(): void {
  if (tray) return; // Already created

  const iconPath = path.join(__dirname, '../build/icon-16.png');
  let trayIcon: Electron.NativeImage;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty();
    }
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  // macOS menu bar icons are template images (monochrome, auto-inverts).
  // On Windows and Linux this flag is a no-op per the Electron docs.
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('SigmaLink');
  updateTrayMenu();

  // Left-click on tray icon reveals the main window.
  // On Windows, double-click is the conventional trigger but single-click also
  // works and is friendlier. On Linux, click behaviour varies by desktop
  // environment; single-click is the safest universal default.
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

/**
 * Register side-band IPC handlers for the global capture channels declared
 * in `rpc-channels.ts`. These live outside the typed AppRouter so we
 * register them directly here rather than threading them through rpc-router.
 */
function registerGlobalCaptureIpc(): void {
  const prefix = 'voice.globalCapture.';

  async function handleChannel(
    name: string,
    handler: () => unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    try {
      return { ok: true, data: await handler() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  ipcMain.handle(`${prefix}getStatus`, () =>
    handleChannel('getStatus', () => globalCaptureCtrl?.getStatus() ?? null),
  );

  ipcMain.handle(`${prefix}setEnabled`, (_e, payload: unknown) => {
    const value = !!(payload as { value?: boolean })?.value;
    return handleChannel('setEnabled', () => { globalCaptureCtrl?.setEnabled(value); updateTrayMenu(); });
  });

  ipcMain.handle(`${prefix}setHotkey`, (_e, payload: unknown) => {
    const h = (payload as { hotkey?: string })?.hotkey;
    if (typeof h !== 'string' || !h) return { ok: false, error: 'hotkey required' };
    return handleChannel('setHotkey', () => { globalCaptureCtrl?.setHotkey(h); updateTrayMenu(); });
  });

  ipcMain.handle(`${prefix}setMode`, (_e, payload: unknown) => {
    const m = (payload as { mode?: string })?.mode;
    if (m !== 'toggle' && m !== 'push-to-talk') return { ok: false, error: 'invalid mode' };
    return handleChannel('setMode', () => { globalCaptureCtrl?.setMode(m); updateTrayMenu(); });
  });

  ipcMain.handle(`${prefix}setModelId`, (_e, payload: unknown) => {
    const id = (payload as { modelId?: string })?.modelId;
    if (typeof id !== 'string') return { ok: false, error: 'modelId required' };
    return handleChannel('setModelId', () => { globalCaptureCtrl?.setModelId(id); });
  });

  // C-11 — "Hey Sigma" listening mode. Persists `voice.listeningMode` and
  // arms/disarms the wake loop. The KV write goes through the same getRawDb
  // handle as the other voice toggles.
  ipcMain.handle(`${prefix}setListeningMode`, (_e, payload: unknown) => {
    const value = !!(payload as { value?: boolean })?.value;
    return handleChannel('setListeningMode', async () => {
      try {
        getRawDb()
          .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
          .run('voice.listeningMode', value ? '1' : '0');
      } catch { /* non-fatal */ }
      if (value) {
        await globalCaptureCtrl?.startListening?.();
      } else {
        await globalCaptureCtrl?.stopListening?.();
      }
      updateTrayMenu();
      return { listeningMode: value };
    });
  });

  ipcMain.handle(`${prefix}downloadModel`, (_e, payload: unknown) => {
    const modelId = (payload as { modelId?: string })?.modelId;
    if (typeof modelId !== 'string') return { ok: false, error: 'modelId required' };
    return handleChannel('downloadModel', async () => {
      const { getModelById, downloadModel } = await import('../src/main/core/voice/model-registry');
      const entry = getModelById(modelId);
      if (!entry) throw new Error(`Unknown model id: ${modelId}`);
      await downloadModel(entry, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('voice:global-capture-toast', {
            message: `Downloading ${entry.name}: ${Math.round(progress.fraction * 100)}%`,
            level: 'info',
            downloadProgress: progress,
          });
        }
      });
      return { downloaded: true };
    });
  });

  ipcMain.handle(`${prefix}abortDownload`, (_e, payload: unknown) => {
    const modelId = (payload as { modelId?: string })?.modelId;
    if (typeof modelId !== 'string') return { ok: false, error: 'modelId required' };
    return handleChannel('abortDownload', async () => {
      const { abortDownload } = await import('../src/main/core/voice/model-registry');
      abortDownload(modelId);
    });
  });
}

/**
 * Initialise the global voice capture controller and wire IPC/KV.
 * Called once inside app.whenReady() after the router (KV) is registered.
 *
 * Extended in v1.5.0 from macOS-only to all desktop platforms (darwin, win32,
 * linux). The underlying whisper-engine and output-router both handle platform
 * differences internally, so the controller wiring is platform-agnostic here.
 */
function initGlobalCapture(): void {

  const kv = {
    get: (key: string): string | null => {
      try {
        const row = getRawDb()
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(key) as { value: string } | undefined;
        return row?.value ?? null;
      } catch { return null; }
    },
    set: (key: string, value: string): void => {
      try {
        getRawDb()
          .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
          .run(key, value);
      } catch { /* non-fatal */ }
    },
  };

  globalCaptureCtrl = buildGlobalCaptureController({
    emit: (event, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(event, payload);
      }
    },
    kv,
    // Deliver models to <userData>/voice-models/ (same as before; now explicit DI)
    getModelsDir: () => path.join(app.getPath('userData'), 'voice-models'),
    // Inject Electron's clipboard — voice-core no longer imports electron directly
    clipboard: {
      writeText: (text: string) => clipboard.writeText(text),
    },
    // C-10b — focused-pane routing deps
    getFocusedSessionId: () => focusedSessionId,
    ptyWrite: (id: string, data: string) => { getSharedDeps()?.pty.write(id, data); },
    injectToPane: () => kv.get('voice.routeToFocusedPane') === '1',
    // C-11 — "Hey Sigma" always-on listening deps (macOS only; the native mic
    // tap is darwin-only, so on win/linux startListening() is a no-op because
    // loadNative()/onPcm are absent).
    getListeningMode: () => kv.get('voice.listeningMode') === '1',
    getTinyModelPath: () => resolveTinyModelPath(),
    isSpeech: (samples: Float32Array) => energyIsSpeech(samples),
    matchesWakeWord: (text: string) => wakeMatch(text),
    createPcmRing: (capacity: number) => new PcmRing(capacity),
  });

  // C-11 — arm the wake loop if listening mode was left on. Best-effort; the
  // controller swallows all errors and is a no-op when the mic is unavailable.
  if (kv.get('voice.listeningMode') === '1') {
    void globalCaptureCtrl.startListening?.();
  }

  // Sync tray menu whenever state changes
  // The controller calls emit('voice:global-capture-state') on every change;
  // we listen via IPC-style callback embedded in the kv wrapper above but
  // here we poll minimally by overriding the emit dep directly.
  updateTrayMenu();
}

/**
 * C-11 — resolve the absolute path to the downloaded tiny.en model used for
 * wake detection (independent of the user's main capture model). Returns null
 * when it has not been downloaded yet (listening then no-ops until download).
 */
function resolveTinyModelPath(): string | null {
  try {
    const entry = getVoiceModelById('tiny.en-q5_1');
    if (!entry) return null;
    return getDownloadedVoiceModelPath(entry);
  } catch {
    return null;
  }
}

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

// C-10b — Renderer pushes the currently active PTY session id whenever it
// changes (via useVoiceFocusSync, debounced ~50ms). Main stores the latest
// value so the global-capture pipeline can pty.write() into the focused pane
// when the "Dictate into the focused pane" toggle is on.
let focusedSessionId: string | null = null;
ipcMain.on('voice:focused-session', (_event, payload: unknown) => {
  if (!isAllowedEvent('voice:focused-session')) return;
  const p = payload as { sessionId?: unknown } | null | undefined;
  focusedSessionId = typeof p?.sessionId === 'string' ? p.sessionId : null;
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

  // v1.5.0 — initialise Tray + global voice capture controller (all platforms).
  // Must run AFTER registerRouter() so the KV store is available.
  try {
    initTray();
    initGlobalCapture();
    registerGlobalCaptureIpc();
  } catch (err) {
    console.warn('[global-capture] init failed (non-fatal):', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // v1.5.0 — suppress quit on ALL platforms when global capture is enabled so
  // the Tray + hotkey persist after the user closes all windows.
  //
  // macOS: window-all-closed suppression has always been needed here — the
  // default Electron behaviour on macOS is NOT to quit on window-all-closed
  // (it re-creates via `activate`), but we also want to keep the process alive
  // on macOS when the user explicitly closes the last window while voice is on.
  //
  // Windows + Linux: these platforms DO quit by default on window-all-closed.
  // The Tray icon (Taskbar notification area on Windows, StatusNotifier on
  // Linux) keeps the app icon visible so users can reopen the window or quit
  // intentionally via Tray → "Quit SigmaLink".
  const captureEnabled = globalCaptureCtrl?.getStatus().enabled ?? false;
  if (captureEnabled) {
    // Keep alive — tray icon remains; user quits via tray menu.
    return;
  }
  // Global capture disabled (or controller not initialised): default quit
  // behaviour. On macOS this means no quit (app re-activates from dock);
  // on Windows/Linux it means quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
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
  // v1.4.9 — unregister global shortcuts + tear down capture before shutting
  // down the router so the audio engine is cleanly stopped.
  try {
    globalCaptureCtrl?.dispose();
    globalShortcut.unregisterAll();
  } catch {
    /* non-fatal */
  }
  // C-11 / K5 — free the process-lifetime whisper_context cache. dispose() above
  // tore down the wake loop, so no transcribe is in flight here. duck-typed so
  // older binaries / the stub (no disposeModels) are tolerated.
  try {
    const engine = getWhisperEngine() as { disposeModels?: () => void } | null;
    engine?.disposeModels?.();
  } catch {
    /* non-fatal */
  }
  try {
    if (getCachedSnapshot()) {
      persistCachedSnapshot();
    }
  } catch {
    /* never let session persistence block shutdown */
  }
  shutdownRouter();
});
