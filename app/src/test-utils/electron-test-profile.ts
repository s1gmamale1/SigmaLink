import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';

export interface ElectronTestProfile {
  rootDir: string;
  userDataDir: string;
  homeDir: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  close(app?: ElectronApplication | null): Promise<void>;
}

export function createElectronTestProfile(prefix = 'sigmalink-electron-test-'): ElectronTestProfile {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const makeDir = (name: string): string => {
    const dir = path.join(rootDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const userDataDir = makeDir('user-data');
  const homeDir = makeDir('home');
  const appDataDir = makeDir('app-data');
  const localAppDataDir = makeDir('local-app-data');
  const xdgConfigDir = makeDir('xdg-config');
  const xdgCacheDir = makeDir('xdg-cache');
  const xdgDataDir = makeDir('xdg-data');
  let closed = false;

  return {
    rootDir,
    userDataDir,
    homeDir,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SIGMA_TEST: '1',
      SIGMA_TEST_PROFILE_ISOLATED: '1',
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      XDG_CONFIG_HOME: xdgConfigDir,
      XDG_CACHE_HOME: xdgCacheDir,
      XDG_DATA_HOME: xdgDataDir,
    },
    async close(app): Promise<void> {
      await app?.close().catch(() => undefined);
      if (closed) return;
      closed = true;
      await fs.promises.rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    },
  };
}
