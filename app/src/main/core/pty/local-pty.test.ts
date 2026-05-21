// Coverage for the synchronous ENOENT pre-flight added to `spawnLocalPty`,
// plus v1.6.0 Phase 1 shell-first mode and shell-quoting helper tests.
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
  posixQuoteArg,
  parseSpawnMode,
  KV_PTY_SPAWN_MODE,
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

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 1 — parseSpawnMode
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSpawnMode', () => {
  it('returns "direct" for null (unset)', () => {
    expect(parseSpawnMode(null)).toBe('direct');
  });

  it('returns "direct" for undefined', () => {
    expect(parseSpawnMode(undefined)).toBe('direct');
  });

  it('returns "direct" for empty string', () => {
    expect(parseSpawnMode('')).toBe('direct');
  });

  it('returns "direct" for an unrecognised value', () => {
    expect(parseSpawnMode('shell_first')).toBe('direct');
    expect(parseSpawnMode('1')).toBe('direct');
    expect(parseSpawnMode('true')).toBe('direct');
  });

  it('returns "shell-first" for the exact string "shell-first"', () => {
    expect(parseSpawnMode('shell-first')).toBe('shell-first');
  });

  it('returns "direct" for "direct"', () => {
    expect(parseSpawnMode('direct')).toBe('direct');
  });

  it('exports the correct KV key constant', () => {
    expect(KV_PTY_SPAWN_MODE).toBe('pty.spawnMode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 1 — posixQuoteArg (shell-quoting helper)
// ─────────────────────────────────────────────────────────────────────────────

describe('posixQuoteArg', () => {
  it('wraps a simple arg in single quotes', () => {
    expect(posixQuoteArg('hello')).toBe("'hello'");
  });

  it('handles args with spaces', () => {
    expect(posixQuoteArg('say hello')).toBe("'say hello'");
  });

  it('handles args with double quotes', () => {
    expect(posixQuoteArg('he said "hi"')).toBe("'he said \"hi\"'");
  });

  it('handles an empty arg', () => {
    expect(posixQuoteArg('')).toBe("''");
  });

  it('escapes an embedded single quote via the classic technique', () => {
    // "it's" → 'it'\''s'
    expect(posixQuoteArg("it's")).toBe("'it'\\''s'");
  });

  it('escapes multiple embedded single quotes', () => {
    // "it's a 'test'" → 'it'\''s a '\''test'\'''
    expect(posixQuoteArg("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('handles backslashes (no escaping needed inside single quotes)', () => {
    expect(posixQuoteArg('C:\\Users\\foo')).toBe("'C:\\Users\\foo'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 1 — spawnLocalPty: direct mode (default) regression guard
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnLocalPty: direct mode (regression guard)', () => {
  it('throws ENOENT synchronously in direct mode when the command is not on PATH', () => {
    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'absolutely-not-a-real-cli-direct-mode',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        spawnMode: 'direct',
      });
    } catch (err) {
      caught = err;
    }
    const e = caught as NodeJS.ErrnoException;
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('ENOENT');
  });

  it('throws ENOENT synchronously when spawnMode is omitted (default is direct)', () => {
    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'absolutely-not-a-real-cli-no-mode',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        // spawnMode intentionally omitted
      });
    } catch (err) {
      caught = err;
    }
    const e = caught as NodeJS.ErrnoException;
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('ENOENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 1 — spawnLocalPty: shell-first mode
//
// We mock node-pty with vi.doMock (NOT hoisted) + vi.resetModules() so the
// mock state captured at the top of each test is stable.
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnLocalPty: shell-first mode', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper: set up a fresh node-pty mock and return an isolated copy of
   * local-pty + a fresh node-pty mock reference. Each call to `setup` must
   * be preceded by `vi.resetModules()` (done inside setup) so the dynamic
   * import gets the doMock'd version, not the previously-cached real module.
   */
  async function setup() {
    const written: string[] = [];
    let dataHandler: ((d: string) => void) | null = null;

    const mockProc = {
      pid: 12345,
      write: (d: string) => { written.push(d); },
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (cb: (d: string) => void) => { dataHandler = cb; },
      onExit: vi.fn(),
    };

    // Reset module cache FIRST so the subsequent doMock + import gets a fresh
    // copy of local-pty that uses our mock rather than the already-cached real
    // node-pty binding.
    vi.resetModules();

    // vi.doMock is NOT hoisted — registers the factory here, before the import
    vi.doMock('node-pty', () => ({
      spawn: vi.fn(() => mockProc),
    }));

    // Dynamic import after resetModules + doMock gets the mocked version
    const { spawnLocalPty: freshSpawn } = await import('./local-pty');
    const nodePty = await import('node-pty');

    return {
      freshSpawn,
      nodePty,
      written,
      fireData: (chunk: string) => { dataHandler?.(chunk); },
    };
  }

  it('spawns the default shell instead of the input command', async () => {
    if (process.platform === 'win32') return; // win32 falls back to direct
    vi.useFakeTimers();

    const { freshSpawn, written, nodePty } = await setup();

    const handle = freshSpawn({
      command: 'claude',
      args: ['--print', 'hello'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    expect(handle).toBeTruthy();
    expect(handle.pid).toBe(12345);
    // No injection yet — waiting for first data
    expect(written.length).toBe(0);

    // The spawned command should be the shell, NOT 'claude'.
    const spawnCalls = vi.mocked(nodePty.spawn).mock.calls;
    expect(spawnCalls.length).toBe(1);
    const spawnedCmd = spawnCalls[0]![0] as string;
    expect(spawnedCmd).not.toBe('claude');
    const shellBasename = spawnedCmd.split('/').pop() ?? spawnedCmd;
    const knownShells = ['zsh', 'bash', 'sh', 'fish', 'dash'];
    const isShell = knownShells.some((s) => shellBasename.startsWith(s));
    expect(isShell).toBe(true);
  });

  it('injects the command line after the first onData chunk', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written, fireData } = await setup();

    freshSpawn({
      command: 'claude',
      args: ['--resume', 'abc-123'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    expect(written.length).toBe(0);
    fireData('% ');

    expect(written.length).toBe(1);
    expect(written[0]).toBe("claude '--resume' 'abc-123'\n");
  });

  it('double-inject guard: second onData does not re-write', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written, fireData } = await setup();

    freshSpawn({
      command: 'claude',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    fireData('% ');
    fireData('some more output');
    fireData('even more');

    expect(written.length).toBe(1);
  });

  it('fallback timer writes the command if no onData arrives within 250 ms', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written } = await setup();

    freshSpawn({
      command: 'claude',
      args: ['--flag'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    expect(written.length).toBe(0);
    vi.advanceTimersByTime(251);

    expect(written.length).toBe(1);
    expect(written[0]).toBe("claude '--flag'\n");
  });

  it('fallback timer does not double-inject if onData already fired', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written, fireData } = await setup();

    freshSpawn({
      command: 'claude',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    fireData('% ');
    expect(written.length).toBe(1);

    vi.advanceTimersByTime(300);
    expect(written.length).toBe(1);
  });

  it('win32: shell-first falls back to direct mode (ENOENT for missing command)', () => {
    if (process.platform !== 'win32') return;

    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'not-a-real-binary',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
      });
    } catch (err) {
      caught = err;
    }
    // On win32, shell-first silently degrades to direct, which then hits ENOENT
    const e = caught as NodeJS.ErrnoException;
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('ENOENT');
  });
});
