// SigmaVoice — main process
//
// Standalone system-wide dictation app powered by @sigmalink/voice-core.
//
// Flow:
//   1. App starts, Tray icon appears.
//   2. User presses hotkey (default: Cmd+Alt+Space on mac, Ctrl+Alt+Space on win/linux).
//   3. Global capture starts (AVAudioEngine / SAPI5 → whisper.cpp → clipboard + AX-paste).
//   4. A minimal settings window lets the user change model / hotkey / output mode.
//
// No workspace/pane/session/swarm logic — this is pure dictation.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from 'electron';
import {
  buildGlobalCaptureController,
  type GlobalCaptureController,
  MODEL_CATALOG,
  isModelDownloaded,
  downloadModel,
  abortDownload,
  isDownloading,
  type DownloadProgress,
} from '@sigmalink/voice-core';
import { createFileKv, type KvStore } from './kv-store';
import { getDictionary, setDictionary, getStatsSummary } from './settings-data';
import { createHudWindow } from './hud-window';
import { createHotkeyManager, type HotkeyManager } from './hotkey-manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// KV — file-backed store under <userData>/sigmavoice-kv.json.
// Persists the dictionary + usage stats across restarts (v0.2 used an
// in-memory Map that lost them on quit). Created in whenReady() once the
// userData path is available.
// ---------------------------------------------------------------------------

let kv: KvStore | null = null;

// ---------------------------------------------------------------------------
// Models directory — store under <userData>/voice-models/
// ---------------------------------------------------------------------------

function getModelsDir(): string {
  return path.join(app.getPath('userData'), 'voice-models');
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let captureCtrl: GlobalCaptureController | null = null;

// Focus-preserving recording HUD overlay. Assigned in whenReady() to the
// controller returned by createHudWindow() (src/hud-window.ts); structurally
// typed here so this file is independent of that module's import.
interface HudLike {
  showRecording(): void;
  showTranscribing(): void;
  hide(): void;
  destroy(): void;
}
let hud: HudLike | null = null;
let hotkeyMgr: HotkeyManager | null = null;
// True when the global key-UP listener could not attach (e.g. Input Monitoring
// not granted). In push-to-talk mode this means hold-to-talk is unavailable and
// the hotkey degrades to tap-to-toggle — we tell the user when it matters.
let pttListenerUnavailable = false;

/** Notify the user that push-to-talk degraded to tap-to-toggle. */
function warnPushToTalkDegraded(): void {
  const body =
    'Hold-to-talk needs Input Monitoring (System Settings → Privacy & ' +
    'Security → Input Monitoring). Until granted, the hotkey works as ' +
    'tap-to-toggle: press once to start, press again to stop.';
  try {
    if (Notification.isSupported()) {
      new Notification({ title: 'SigmaVoice — push-to-talk limited', body }).show();
    }
  } catch {
    /* notifications are best-effort */
  }
  // Also surface in the settings window if it's open.
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('voice:global-capture-toast', {
      message: body,
      level: 'warn',
    });
  }
}

/** Drive the HUD overlay from capture-state changes. */
function syncHud(payload: unknown): void {
  if (!hud) return;
  const state = (payload as { state?: string } | null)?.state;
  if (state === 'recording') hud.showRecording();
  else if (state === 'transcribing') hud.showTranscribing();
  else hud.hide(); // idle / routing → dismiss
}

// ---------------------------------------------------------------------------
// Tray menu
// ---------------------------------------------------------------------------

function buildTrayMenu(): Electron.Menu {
  const ctrl = captureCtrl;
  const status = ctrl?.getStatus();
  const isEnabled   = status?.enabled ?? false;
  const isRecording = status?.state === 'recording';

  return Menu.buildFromTemplate([
    {
      label: isRecording
        ? 'Stop recording'
        : isEnabled
          ? `Start recording (${status?.hotkey ?? ''})`
          : 'Global capture (disabled)',
      enabled: isEnabled,
      click: () => {
        if (!ctrl) return;
        if (isRecording) void ctrl.stopAndTranscribe();
        else void ctrl.startRecording();
      },
    },
    { type: 'separator' },
    {
      label: isEnabled ? 'Disable global capture' : 'Enable global capture',
      click: () => ctrl?.setEnabled(!isEnabled),
    },
    {
      label: 'Settings…',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit SigmaVoice',
      click: () => app.quit(),
    },
  ]);
}

function updateTray(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());

  const status = captureCtrl?.getStatus();
  const isRecording = status?.state === 'recording';
  tray.setToolTip(
    isRecording ? 'SigmaVoice — Recording…' : 'SigmaVoice',
  );
}

function initTray(): void {
  // Use a 16×16 transparent icon stub — replace with actual icon in production
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('SigmaVoice');
  tray.setContextMenu(buildTrayMenu());
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 520,
    title: 'SigmaVoice Settings',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // The build emits preload.cjs (CJS) into sigma-dist/ — NOT preload.js.
      // v0.2 referenced 'preload.js' here, so window.bridgeVoice never loaded.
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC handlers (settings window ↔ main)
// ---------------------------------------------------------------------------

function registerIpc(): void {
  // Get current capture status
  ipcMain.handle('bv:getStatus', () => captureCtrl?.getStatus() ?? null);

  // Enable / disable
  ipcMain.handle('bv:setEnabled', (_e, enabled: boolean) => {
    captureCtrl?.setEnabled(enabled);
  });

  // Change hotkey
  ipcMain.handle('bv:setHotkey', (_e, hotkey: string) => {
    if (typeof hotkey === 'string' && hotkey.trim()) {
      captureCtrl?.setHotkey(hotkey.trim());
    }
  });

  // Change capture mode (toggle vs push-to-talk)
  ipcMain.handle('bv:setMode', (_e, mode: string) => {
    if (mode === 'toggle' || mode === 'push-to-talk') {
      captureCtrl?.setMode(mode);
      // Switching INTO push-to-talk while the key-UP listener never attached →
      // warn that hold-to-talk won't work until Input Monitoring is granted.
      if (mode === 'push-to-talk' && pttListenerUnavailable) warnPushToTalkDegraded();
    }
  });

  // Change active model
  ipcMain.handle('bv:setModelId', (_e, id: string) => {
    captureCtrl?.setModelId(id);
  });

  // Manual trigger (for settings UI test button)
  ipcMain.handle('bv:startRecording', () => captureCtrl?.startRecording());
  ipcMain.handle('bv:stopAndTranscribe', () => captureCtrl?.stopAndTranscribe());

  // Dictionary + verbal macros (persisted in KV 'voice.dictionary'; consumed by
  // voice-core normalizeTranscript on every transcription).
  ipcMain.handle('bv:getDictionary', () => (kv ? getDictionary(kv) : []));
  ipcMain.handle('bv:setDictionary', (_e, entries: unknown) =>
    kv ? setDictionary(kv, entries) : [],
  );

  // Usage stats summary (aggregated from KV 'voice.stats').
  ipcMain.handle('bv:getStats', () =>
    kv ? getStatsSummary(kv) : { totalWords: 0, recordings: 0, avgWpm: 0, recent: [] },
  );

  // --- Whisper model management -------------------------------------------
  // List the catalog with per-model status (downloaded / downloading / active).
  ipcMain.handle('bv:listModels', () => {
    const modelsDir = getModelsDir();
    const activeId = captureCtrl?.getStatus().modelId;
    return MODEL_CATALOG.map((m) => ({
      id: m.id,
      name: m.name,
      sizeMb: m.sizeMb,
      isDefault: m.isDefault,
      downloaded: isModelDownloaded(m, modelsDir),
      downloading: isDownloading(m.id),
      active: m.id === activeId,
    }));
  });

  // Download a model; streams progress to the settings window over
  // 'voice:model-download', resolves when complete (or rejects → caught here).
  ipcMain.handle('bv:downloadModel', async (_e, id: string) => {
    const entry = MODEL_CATALOG.find((m) => m.id === id);
    if (!entry) return { ok: false, error: `Unknown model: ${id}` };
    const emit = (p: DownloadProgress): void => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('voice:model-download', p);
      }
    };
    try {
      await downloadModel(entry, getModelsDir(), emit);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ modelId: id, bytesDone: 0, bytesTotal: 0, fraction: 0, done: true, error: message });
      return { ok: false, error: message };
    }
  });

  // Abort an in-flight download.
  ipcMain.handle('bv:abortDownload', (_e, id: string) => {
    try { abortDownload(id); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance lock — a second launch focuses the existing instance's
// settings window instead of starting a duplicate tray + global key listener
// (which would double-register the hotkey and fight over the mic).
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return; // secondary instance is quitting

  // macOS: hide from Dock (system-tray-only app)
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  // Persistent KV — created now that userData is resolvable.
  const store = createFileKv(path.join(app.getPath('userData'), 'sigmavoice-kv.json'));
  kv = store;

  captureCtrl = buildGlobalCaptureController({
    emit: (event, payload) => {
      // Forward to settings window if open
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send(event, payload);
      }
      // Rebuild tray menu + drive the recording HUD on state changes
      if (event === 'voice:global-capture-state') {
        updateTray();
        syncHud(payload);
      }
    },
    kv: store,
    getModelsDir,
    clipboard: {
      writeText: (text: string) => clipboard.writeText(text),
    },
  });

  // Focus-preserving recording HUD overlay (lazily shown on first record).
  hud = createHudWindow({
    preloadPath: path.join(__dirname, 'hud-preload.cjs'),
    htmlPath: path.join(__dirname, '..', 'renderer', 'hud.html'),
  });

  // True push-to-talk: supply the key-UP edge Electron's globalShortcut lacks.
  // Key-DOWN/start stays on the controller's globalShortcut; on release in
  // push-to-talk mode we stop+transcribe. (Toggle mode is fully owned by the
  // controller, so this is a no-op there.)
  hotkeyMgr = createHotkeyManager({
    getMode: () => captureCtrl?.getStatus().mode ?? 'toggle',
    getHotkey: () => captureCtrl?.getStatus().hotkey ?? '',
    onPushToTalkRelease: () => { void captureCtrl?.stopAndTranscribe(); },
    onListenerUnavailable: () => {
      pttListenerUnavailable = true;
      // Only worth telling the user if they're actually in push-to-talk mode.
      if (captureCtrl?.getStatus().mode === 'push-to-talk') warnPushToTalkDegraded();
    },
  });
  hotkeyMgr.start();

  initTray();
  registerIpc();
});

// Keep app alive when all windows are closed (tray app)
app.on('window-all-closed', () => {
  // Intentionally do NOT quit — the tray keeps the process alive.
  // User must choose Quit from the tray menu.
});

let quitting = false;
app.on('before-quit', () => {
  if (quitting) return; // idempotent
  quitting = true;
  // Guarded teardown. NOTE (W-SV2): the voice natives release an N-API
  // ThreadSafeFunction during dispose that can SIGABRT at quit
  // (napi_release_threadsafe_function → uv_mutex_lock) — a quit-time teardown
  // race, app already exiting. Proper fix is in tsfn_bridge release semantics.
  try { hotkeyMgr?.stop(); } catch { /* ignore */ }
  try { hud?.destroy(); } catch { /* ignore */ }
  try { captureCtrl?.dispose(); } catch { /* ignore */ }
});

// macOS: re-activate on Dock click (rare since Dock is hidden, but safe)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openSettingsWindow();
  }
});

// Keep TypeScript happy about unused import
void os;
