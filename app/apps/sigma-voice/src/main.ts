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
  Tray,
} from 'electron';
import {
  buildGlobalCaptureController,
  type GlobalCaptureController,
} from '@sigmalink/voice-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// KV — in-memory store backed by a plain object.
// For production: swap to better-sqlite3 or Electron Store.
// ---------------------------------------------------------------------------

const kvStore = new Map<string, string>();

const kv = {
  get: (key: string): string | null => kvStore.get(key) ?? null,
  set: (key: string, value: string): void => { kvStore.set(key, value); },
};

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
      preload: path.join(__dirname, 'preload.js'),
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

  // Change active model
  ipcMain.handle('bv:setModelId', (_e, id: string) => {
    captureCtrl?.setModelId(id);
  });

  // Manual trigger (for settings UI test button)
  ipcMain.handle('bv:startRecording', () => captureCtrl?.startRecording());
  ipcMain.handle('bv:stopAndTranscribe', () => captureCtrl?.stopAndTranscribe());
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // macOS: hide from Dock (system-tray-only app)
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  captureCtrl = buildGlobalCaptureController({
    emit: (event, payload) => {
      // Forward to settings window if open
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send(event, payload);
      }
      // Rebuild tray menu on state changes
      if (event === 'voice:global-capture-state') {
        updateTray();
      }
    },
    kv,
    getModelsDir,
    clipboard: {
      writeText: (text: string) => clipboard.writeText(text),
    },
  });

  initTray();
  registerIpc();
});

// Keep app alive when all windows are closed (tray app)
app.on('window-all-closed', () => {
  // Intentionally do NOT quit — the tray keeps the process alive.
  // User must choose Quit from the tray menu.
});

app.on('before-quit', () => {
  captureCtrl?.dispose();
});

// macOS: re-activate on Dock click (rare since Dock is hidden, but safe)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openSettingsWindow();
  }
});

// Keep TypeScript happy about unused import
void os;
