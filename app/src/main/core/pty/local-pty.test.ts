// Coverage for the synchronous ENOENT pre-flight added to `spawnLocalPty`.
//
// Background: node-pty surfaces missing binaries asynchronously on POSIX
// (the helper forks fine and exec(127)s inside the child). That left
// `resolveAndSpawn` unable to walk `[command, ...altCommands]` because the
// first attempt always "succeeded" from the registry's point of view.
//
// `spawnLocalPty` now resolves the command against PATH up-front and throws a
// real ENOENT before invoking node-pty, restoring the fallback contract.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

// We DON'T mock node-pty here: the ENOENT check fires before node-pty is
// touched, so the native module is never loaded during these tests.
import {
  resolvePosixCommand,
  resolveWindowsCommand,
  spawnLocalPty,
} from './local-pty';

const originalPath = process.env.PATH;
const originalPlatform = process.platform;

afterEach(() => {
  process.env.PATH = originalPath;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('resolvePosixCommand', () => {
  it('returns null for an unknown bare command', () => {
    // Force an empty PATH so resolution must fail.
    process.env.PATH = '/does/not/exist';
    expect(resolvePosixCommand('definitely-not-a-real-binary-xyz')).toBeNull();
  });

  it('finds a known binary on the host PATH', () => {
    process.env.PATH = originalPath;
    // `sh` exists on every POSIX system and is on the default test path.
    if (process.platform === 'win32') return;
    const resolved = resolvePosixCommand('sh');
    expect(resolved).toBeTruthy();
    expect(fs.existsSync(resolved as string)).toBe(true);
  });

  it('returns null for a non-existent absolute path', () => {
    expect(resolvePosixCommand('/no/such/file/here/xyz')).toBeNull();
  });

  it('returns the path for an existing absolute file', () => {
    // /bin/sh or /usr/bin/sh exists on POSIX. Fall back gracefully.
    if (process.platform === 'win32') return;
    const candidate = fs.existsSync('/bin/sh') ? '/bin/sh' : '/usr/bin/sh';
    expect(resolvePosixCommand(candidate)).toBe(candidate);
  });

  it('returns null for an empty command', () => {
    expect(resolvePosixCommand('')).toBeNull();
  });
});

describe('spawnLocalPty ENOENT pre-flight', () => {
  it('throws ENOENT synchronously when the command is not on PATH', () => {
    // Pick a command guaranteed to be missing.
    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'absolutely-not-a-real-cli-zzzqqq',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as NodeJS.ErrnoException;
    expect(e.code).toBe('ENOENT');
    expect(e.message).toMatch(/ENOENT/);
  });

  it('does not throw for an empty command (default shell path)', () => {
    // Empty command means "open the user's default shell" — that path takes
    // over inside `platformAwareSpawnArgs` and we should not pre-flight it
    // against PATH (the resolved shell is always real, by construction).
    // We can't actually invoke node-pty here without a TTY, so spy on
    // `spawnLocalPty`'s exit path: assert no synchronous throw happens.
    //
    // The native node-pty spawn IS attempted; on a CI runner it succeeds.
    // If it doesn't (e.g. no /bin/sh), we still verify the ENOENT path
    // didn't fire by inspecting the thrown error's code.
    let handle: ReturnType<typeof spawnLocalPty> | null = null;
    let caught: unknown = null;
    try {
      handle = spawnLocalPty({
        command: '',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
    } catch (err) {
      caught = err;
    }
    // Either a handle was produced, OR a non-ENOENT failure occurred (the
    // pre-flight was correctly skipped). We never want the pre-flight ENOENT
    // to fire for an empty command.
    if (caught) {
      expect((caught as NodeJS.ErrnoException).code).not.toBe('ENOENT');
    } else {
      expect(handle).toBeTruthy();
      // Clean up the live PTY so the test process exits cleanly.
      try {
        handle?.kill();
      } catch {
        /* ignore */
      }
    }
  });
});

describe('resolveWindowsCommand (smoke test on non-Windows host)', () => {
  it('returns null for empty input regardless of platform', () => {
    expect(resolveWindowsCommand('')).toBeNull();
  });
});
