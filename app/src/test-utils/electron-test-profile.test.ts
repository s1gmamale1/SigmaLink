import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElectronTestProfile, type ElectronTestProfile } from './electron-test-profile';

let profile: ElectronTestProfile | null = null;

afterEach(async () => {
  await profile?.close();
  profile = null;
});

describe('createElectronTestProfile', () => {
  it('isolates Electron, home, and platform configuration roots', () => {
    profile = createElectronTestProfile('sigmalink-profile-test-');

    expect(profile.args).toContain(`--user-data-dir=${profile.userDataDir}`);
    expect(profile.env.SIGMA_TEST_PROFILE_ISOLATED).toBe('1');
    expect(profile.env.HOME).toBe(profile.homeDir);
    expect(profile.env.USERPROFILE).toBe(profile.homeDir);
    const workspaceDir = Reflect.get(profile, 'workspaceDir') as unknown;
    expect(workspaceDir).toBeTypeOf('string');
    expect(fs.existsSync(workspaceDir as string)).toBe(true);
    expect(path.relative(profile.rootDir, workspaceDir as string)).not.toMatch(/^\.\./);
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
      const value = profile.env[key];
      expect(value).toBeTruthy();
      expect(path.relative(profile.rootDir, value!)).not.toMatch(/^\.\./);
    }
    expect(fs.existsSync(profile.userDataDir)).toBe(true);
    expect(fs.existsSync(profile.homeDir)).toBe(true);
  });

  it('always closes the application before deleting the isolated roots', async () => {
    profile = createElectronTestProfile('sigmalink-profile-order-');
    const rootDir = profile.rootDir;
    let rootExistedDuringClose = false;
    await profile.close({
      close: async () => {
        rootExistedDuringClose = fs.existsSync(rootDir);
      },
    } as never);

    expect(rootExistedDuringClose).toBe(true);
    expect(fs.existsSync(rootDir)).toBe(false);
    profile = null;
  });
});
