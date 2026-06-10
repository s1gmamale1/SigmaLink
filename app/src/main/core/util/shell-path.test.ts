// perf-hot-paths Task 4 — cached async login-shell PATH bootstrap. All deps
// injected (no electron, no real shell spawn). Real timers — async settling
// is driven by resolving the injected promises.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mergeShellPath,
  startShellPathBootstrap,
  whenShellPathReady,
  __resetShellPathForTests,
  type ShellPathDeps,
} from './shell-path';

beforeEach(() => {
  __resetShellPathForTests();
});

describe('mergeShellPath', () => {
  it('prefers shell-resolved entries first and dedupes', () => {
    expect(mergeShellPath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', ':')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin',
    );
  });

  it('drops empty segments', () => {
    expect(mergeShellPath(':/a::', '/b:', ':')).toBe('/a:/b');
  });
});

function makeDeps(over: Partial<ShellPathDeps> = {}): ShellPathDeps & {
  setEnvPath: ReturnType<typeof vi.fn>;
  writeCache: ReturnType<typeof vi.fn>;
} {
  let envPath = '/usr/bin:/bin';
  const setEnvPath = vi.fn((next: string) => {
    envPath = next;
  });
  const writeCache = vi.fn();
  const deps: ShellPathDeps = {
    platform: 'darwin' as NodeJS.Platform,
    isDev: false,
    shell: '/bin/zsh',
    pathDelimiter: ':',
    readCache: () => null as string | null,
    getEnvPath: () => envPath,
    resolveShellPath: vi.fn(async () => '/opt/homebrew/bin:/usr/bin'),
    timeoutMs: 3_000,
    ...over,
    // The two assertion targets are never overridden by callers, so reattach
    // them last to keep their concrete Mock type (a spread of Partial widens
    // them to a union otherwise).
    setEnvPath,
    writeCache,
  };
  return { ...deps, setEnvPath, writeCache };
}

describe('startShellPathBootstrap', () => {
  it('warm boot: applies the cached PATH synchronously and is ready immediately', async () => {
    const deps = makeDeps({ readCache: () => '/opt/homebrew/bin' });
    startShellPathBootstrap(deps);

    // Cache applied before ANY async work (DMG-launch ENOENT window closed).
    expect(deps.setEnvPath).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin:/bin');
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });

  it('warm boot: the background refresh still updates env + rewrites the cache', async () => {
    const deps = makeDeps({ readCache: () => '/stale/bin' });
    await startShellPathBootstrap(deps); // returned promise = refresh completion
    expect(deps.writeCache).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin');
    // setEnvPath called twice: cache apply, then live-resolve merge.
    expect(deps.setEnvPath).toHaveBeenCalledTimes(2);
  });

  it('cold boot (no cache): not ready until the live resolve lands', async () => {
    let release: (v: string | null) => void = () => {};
    const deps = makeDeps({
      resolveShellPath: vi.fn(
        () =>
          new Promise<string | null>((r) => {
            release = r;
          }),
      ),
    });
    const refresh = startShellPathBootstrap(deps);

    let settled = false;
    void whenShellPathReady(60_000).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // first spawn would still be waiting

    release('/opt/homebrew/bin');
    await refresh;
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
    expect(deps.setEnvPath).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin:/bin');
    expect(deps.writeCache).toHaveBeenCalledWith('/opt/homebrew/bin');
  });

  it('whenShellPathReady caps the wait (a hung shell never deadlocks spawns)', async () => {
    const deps = makeDeps({
      resolveShellPath: vi.fn(() => new Promise<string | null>(() => {})), // never resolves
    });
    startShellPathBootstrap(deps);
    await expect(whenShellPathReady(50)).resolves.toBeUndefined(); // ~50ms real wait
  });

  it('non-darwin and dev are exact no-ops (ready immediately, no resolve)', async () => {
    const win = makeDeps({ platform: 'win32' });
    startShellPathBootstrap(win);
    expect(win.resolveShellPath).not.toHaveBeenCalled();
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();

    __resetShellPathForTests();
    const dev = makeDeps({ isDev: true });
    startShellPathBootstrap(dev);
    expect(dev.resolveShellPath).not.toHaveBeenCalled();
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });

  it('a null resolve (shell failed) keeps the cache-less env untouched but still resolves ready', async () => {
    const deps = makeDeps({ resolveShellPath: vi.fn(async () => null) });
    await startShellPathBootstrap(deps);
    expect(deps.setEnvPath).not.toHaveBeenCalled();
    expect(deps.writeCache).not.toHaveBeenCalled();
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });

  it('whenShellPathReady resolves immediately when bootstrap never ran (tests, win32 boot paths)', async () => {
    await expect(whenShellPathReady(10)).resolves.toBeUndefined();
  });
});
