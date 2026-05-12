// V3-W14-008 — `electron-updater` integration. Opt-in by default.
// v1.2.4: Windows unsigned bypass + macOS manual DMG handoff.

import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { getRawDb } from '../src/main/core/db/client';
import { download as httpDownload } from '../src/main/lib/http-download';

const KV_OPT_IN = 'updates.optIn';
const KV_LAST_CHECK = 'updates.lastCheckTimestamp';

let configured = false;
let macDmgPath: string | null = null;

function kvGet(key: string): string | null {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function kvSet(key: string, value: string): void {
  try {
    getRawDb()
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  } catch {
    /* db not initialised yet */
  }
}

function broadcast(channel: string, payload: any): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function configureUpdater(): void {
  if (configured) return;
  configured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => {
    broadcast('app:update-available', { version: info.version });

    if (process.platform === 'darwin') {
      // macOS: extract DMG URL and download manually to bypass Squirrel.Mac signature wall
      const dmgFile = info.files.find(f => f.url.endsWith('.dmg'));
      if (!dmgFile) {
        broadcast('app:update-error', { error: 'No DMG found in release manifest' });
        return;
      }
      const dest = path.join(app.getPath('downloads'), `SigmaLink-${info.version}.dmg`);
      macDmgPath = dest;
      let cumulative = 0;
      httpDownload(
        dmgFile.url,
        dest,
        (delta, total) => {
          cumulative += delta;
          broadcast('app:update-mac-dmg-progress', { version: info.version, downloaded: cumulative, total });
        }
      ).then(() => {
        broadcast('app:update-mac-dmg-ready', { version: info.version, path: dest });
      }).catch(err => {
        broadcast('app:update-error', { error: err.message });
      });
    } else if (process.platform === 'win32') {
      // Windows: Proceed with standard download (signature check bypassed in electron-builder.yml)
      autoUpdater.downloadUpdate().catch(err => {
        broadcast('app:update-error', { error: err.message });
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (process.platform === 'win32') {
      broadcast('app:update-win-progress', {
        version: autoUpdater.updateInfo?.version,
        downloaded: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (process.platform === 'win32') {
      broadcast('app:update-win-ready', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    broadcast('app:update-error', { error: err.message });
  });
}

function stampLastCheck(): void {
  kvSet(KV_LAST_CHECK, String(Date.now()));
}

export async function checkForUpdates(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  configureUpdater();
  if (!app.isPackaged) {
    stampLastCheck();
    return {
      ok: false,
      error: 'Updates are only checked in packaged builds.',
    };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    stampLastCheck();
    return { ok: true, version: result?.updateInfo?.version };
  } catch (err) {
    stampLastCheck();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function maybeCheckOnBoot(): void {
  configureUpdater();
  if (kvGet(KV_OPT_IN) !== '1') return;
  if (!app.isPackaged) return;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3_000);
}

export async function quitAndInstallImpl(): Promise<void> {
  if (process.platform === 'win32') {
    autoUpdater.quitAndInstall();
  } else if (process.platform === 'darwin') {
    if (!macDmgPath) {
      throw new Error('No DMG download available. Check for updates first.');
    }
    await shell.openPath(macDmgPath);
    app.quit();
  } else {
    throw new Error(`Auto-install is not supported on ${process.platform}`);
  }
}
