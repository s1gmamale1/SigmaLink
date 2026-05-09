// Electron main process bootstrap.
// Window lifecycle + delegate every IPC channel to the typed RPC router.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell } from 'electron';
import { registerRouter, shutdownRouter, getSharedDeps } from '../src/main/rpc-router';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

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

  mainWindow.once('ready-to-show', () => mainWindow?.show());

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
  registerRouter();
  createWindow();
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
