// Packaging-hook regression tests for scripts/adhoc-sign.cjs.
//
// Why these live here and not next to the script: vitest.config.ts only sweeps
// src/**, packages/**, tests/perf/**, and electron/**, so a test under
// scripts/__tests__ would never run. src/main is also the only project that
// tsconfig.main.json typechecks under `tsc -b`, so putting the test here keeps
// it inside BOTH gates.
//
// What is under test: the spawn-helper chmod safety net, NOT the codesign
// sweep. PR #247 flipped `asar: false` -> `asar: true` in electron-builder.yml.
// electron-builder then emits Contents/Resources/app.asar +
// Contents/Resources/app.asar.unpacked/ and no Contents/Resources/app at all,
// so the hook's hardcoded legacy path stopped matching. Both chmod passes were
// fs.existsSync-guarded, so they logged "skipping" and the build went green
// with the net silently disabled — the exact silent-failure class the script's
// own header forbids. Without the net node-pty's spawn-helper ships 0644 and
// every terminal pane fails to open with EACCES.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type AdhocSignModule = {
  resolveNodeModulesRoot: (appPath: string) => string;
  restoreSpawnHelperPermissions: (appPath: string) => string[];
};

const requireCJS = createRequire(import.meta.url);
const adhocSign = requireCJS('../../../scripts/adhoc-sign.cjs') as AdhocSignModule;

const tempRoots: string[] = [];

/** Create a throwaway `<tmp>/SigmaLink.app` skeleton and return its path. */
function makeAppBundle(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-sign-'));
  tempRoots.push(root);
  const appPath = path.join(root, 'SigmaLink.app');
  fs.mkdirSync(path.join(appPath, 'Contents', 'Resources'), { recursive: true });
  return appPath;
}

/** Materialise a node_modules tree at `resourcesChild` and return its path. */
function makeNodeModules(appPath: string, resourcesChild: string): string {
  const nodeModules = path.join(appPath, 'Contents', 'Resources', resourcesChild, 'node_modules');
  fs.mkdirSync(nodeModules, { recursive: true });
  return nodeModules;
}

/** Write a 0644 `spawn-helper` under node-pty's prebuilds for `arch`. */
function makePrebuiltSpawnHelper(nodeModulesRoot: string, arch: string): string {
  const dir = path.join(nodeModulesRoot, 'node-pty', 'prebuilds', arch);
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'spawn-helper');
  fs.writeFileSync(helper, 'binary');
  fs.chmodSync(helper, 0o644);
  return helper;
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('adhoc-sign resolveNodeModulesRoot', () => {
  it('resolves the asar-unpacked root when electron-builder packs with asar: true', () => {
    const appPath = makeAppBundle();
    const unpacked = makeNodeModules(appPath, 'app.asar.unpacked');

    expect(adhocSign.resolveNodeModulesRoot(appPath)).toBe(unpacked);
  });

  it('falls back to the legacy unpacked-app root when asar is disabled', () => {
    const appPath = makeAppBundle();
    const legacy = makeNodeModules(appPath, 'app');

    expect(adhocSign.resolveNodeModulesRoot(appPath)).toBe(legacy);
  });

  it('prefers the asar-unpacked root when both layouts are present', () => {
    const appPath = makeAppBundle();
    const unpacked = makeNodeModules(appPath, 'app.asar.unpacked');
    makeNodeModules(appPath, 'app');

    expect(adhocSign.resolveNodeModulesRoot(appPath)).toBe(unpacked);
  });

  it('throws naming both candidate paths when neither layout exists', () => {
    const appPath = makeAppBundle();

    expect(() => adhocSign.resolveNodeModulesRoot(appPath)).toThrow(
      /app\.asar\.unpacked[/\\]node_modules[\s\S]*app[/\\]node_modules/,
    );
  });
});

describe('adhoc-sign restoreSpawnHelperPermissions', () => {
  it('chmods 0644 -> 0755 for every darwin prebuild under the asar-unpacked root', () => {
    const appPath = makeAppBundle();
    const unpacked = makeNodeModules(appPath, 'app.asar.unpacked');
    const arm = makePrebuiltSpawnHelper(unpacked, 'darwin-arm64');
    const x64 = makePrebuiltSpawnHelper(unpacked, 'darwin-x64');

    const fixed = adhocSign.restoreSpawnHelperPermissions(appPath);

    expect(modeOf(arm)).toBe(0o755);
    expect(modeOf(x64)).toBe(0o755);
    expect(fixed).toHaveLength(2);
  });

  it('chmods helpers under the legacy root too', () => {
    const appPath = makeAppBundle();
    const legacy = makeNodeModules(appPath, 'app');
    const helper = makePrebuiltSpawnHelper(legacy, 'darwin-arm64');

    adhocSign.restoreSpawnHelperPermissions(appPath);

    expect(modeOf(helper)).toBe(0o755);
  });

  it('finds helpers outside node-pty prebuilds via the generic sweep', () => {
    const appPath = makeAppBundle();
    const unpacked = makeNodeModules(appPath, 'app.asar.unpacked');
    const dir = path.join(unpacked, 'some-other-dep', 'build', 'Release');
    fs.mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, 'spawn-helper');
    fs.writeFileSync(helper, 'binary');
    fs.chmodSync(helper, 0o644);

    adhocSign.restoreSpawnHelperPermissions(appPath);

    expect(modeOf(helper)).toBe(0o755);
  });

  it('throws when node-pty prebuilds exist but ship no darwin spawn-helper', () => {
    const appPath = makeAppBundle();
    const unpacked = makeNodeModules(appPath, 'app.asar.unpacked');
    fs.mkdirSync(path.join(unpacked, 'node-pty', 'prebuilds', 'darwin-arm64'), {
      recursive: true,
    });

    expect(() => adhocSign.restoreSpawnHelperPermissions(appPath)).toThrow(/spawn-helper/);
  });

  it('throws when the packed app ships no spawn-helper anywhere', () => {
    const appPath = makeAppBundle();
    makeNodeModules(appPath, 'app.asar.unpacked');

    expect(() => adhocSign.restoreSpawnHelperPermissions(appPath)).toThrow(/spawn-helper/);
  });

  it('throws when no node_modules root exists at all', () => {
    const appPath = makeAppBundle();

    expect(() => adhocSign.restoreSpawnHelperPermissions(appPath)).toThrow(/node_modules/);
  });
});
