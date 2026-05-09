// V3-W14-008 — `electron-updater` integration. Opt-in by default. Two paths:
//   1. Boot: when `kv['updates.optIn']==='1'` we run checkForUpdatesAndNotify()
//      ~3s after `app.whenReady()`.
//   2. Manual: `app.checkForUpdates` RPC from Settings → Updates.
// Last-check stamp lives at `kv['updates.lastCheckTimestamp']`. macOS code-
// signing is out-of-scope for v1; users get an unsigned dmg until a
// Developer ID is attached.

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getRawDb } from '../src/main/core/db/client';

const KV_OPT_IN = 'updates.optIn';
const KV_LAST_CHECK = 'updates.lastCheckTimestamp';

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
    /* db not initialised yet — caller will retry next tick */
  }
}

let configured = false;

function configureUpdater(): void {
  if (configured) return;
  configured = true;
  // Never auto-install. The user opts in to the *check*; an actual install
  // still requires their explicit click in the renderer dialog.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;
}

function stampLastCheck(): void {
  kvSet(KV_LAST_CHECK, String(Date.now()));
}

/**
 * Run a check now. Resolves with whatever electron-updater reports; we never
 * throw on "no update available" — that's a normal outcome surfaced via the
 * `version` field being undefined.
 */
export async function checkForUpdates(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  configureUpdater();
  // In dev (un-packaged) electron-updater short-circuits to dev-app-update.yml
  // which is missing, so flag this case explicitly to spare the user a noisy
  // error toast.
  if (!app.isPackaged) {
    stampLastCheck();
    return {
      ok: false,
      error: 'Updates are only checked in packaged builds. Run a release build to test.',
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

/**
 * Boot-time: if the user has opted in, fire a check ~3s after ready so the
 * UI has settled. We use `checkForUpdatesAndNotify()` here so the OS-native
 * "update available" notification surfaces if a new release is published.
 */
export function maybeCheckOnBoot(): void {
  configureUpdater();
  if (kvGet(KV_OPT_IN) !== '1') return;
  if (!app.isPackaged) return;
  setTimeout(() => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch(() => {
        /* electron-updater logs the error; we just stamp the attempt */
      })
      .finally(() => stampLastCheck());
  }, 3_000);
}
