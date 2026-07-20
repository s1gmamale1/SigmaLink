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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We DON'T mock node-pty here: the ENOENT check fires before node-pty is
// touched, so the native module is never loaded during these tests.
import {
  resolvePosixCommand,
  resolveWindowsCommand,
  spawnLocalPty,
  posixQuoteArg,
  parseSpawnMode,
  resolveEffectiveSpawnMode,
  KV_PTY_SPAWN_MODE,
  buildShellCommandLine,
  defaultShell,
} from './local-pty';
import { extractSentinel, SENTINEL_PREFIX, SENTINEL_SUFFIX } from './sentinel';

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

  it('uses supplied env.PATH instead of process.env.PATH', () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posix-path-env-'));
    try {
      const tool = path.join(dir, 'env-only-tool');
      fs.writeFileSync(tool, '#!/bin/sh\n');
      fs.chmodSync(tool, 0o755);
      process.env.PATH = '/does/not/exist';

      expect(resolvePosixCommand('env-only-tool', { PATH: dir })).toBe(tool);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('does not throw for an empty command (default shell path)', async () => {
    // Empty command means "open the user's default shell" — that path takes
    // over inside `platformAwareSpawnArgs` and we should not pre-flight it
    // against PATH (the resolved shell is always real, by construction).
    // Isolate the native binding: spawning a real ConPTY here leaves
    // node-pty's AttachConsole helper racing Vitest teardown on Windows.
    const mockProc = {
      pid: 12345,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    vi.resetModules();
    vi.doMock('node-pty', () => ({
      spawn: vi.fn(() => mockProc),
    }));

    try {
      const { spawnLocalPty: freshSpawn } = await import('./local-pty');
      const nodePty = await import('node-pty');
      const handle = freshSpawn({
        command: '',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });

      expect(handle).toBeTruthy();
      expect(vi.mocked(nodePty.spawn)).toHaveBeenCalledOnce();
      handle.kill();
      expect(mockProc.kill).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('node-pty');
    }
  });
});

describe('resolveWindowsCommand (smoke test on non-Windows host)', () => {
  it('returns null for empty input regardless of platform', () => {
    expect(resolveWindowsCommand('')).toBeNull();
  });

  it('uses the supplied env rather than process.env for PATH/PATHEXT resolution', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\tools\\agent.CMD',
    );

    expect(resolveWindowsCommand('agent', { Path: 'C:\\tools', Pathext: '.CMD' })).toBe(
      'C:\\tools\\agent.CMD',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 1 — parseSpawnMode
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSpawnMode', () => {
  // Phase 7 default flip: unset/absent/null/undefined now resolves to 'shell-first'.

  it('returns "shell-first" for null (unset) — Phase 7 default', () => {
    expect(parseSpawnMode(null)).toBe('shell-first');
  });

  it('returns "shell-first" for undefined — Phase 7 default', () => {
    expect(parseSpawnMode(undefined)).toBe('shell-first');
  });

  it('returns "shell-first" for empty string — Phase 7 default', () => {
    expect(parseSpawnMode('')).toBe('shell-first');
  });

  it('returns "shell-first" for an unrecognised value — Phase 7 default', () => {
    expect(parseSpawnMode('shell_first')).toBe('shell-first');
    expect(parseSpawnMode('1')).toBe('shell-first');
    expect(parseSpawnMode('true')).toBe('shell-first');
  });

  it('returns "shell-first" for the exact string "shell-first"', () => {
    expect(parseSpawnMode('shell-first')).toBe('shell-first');
  });

  it('returns "direct" for explicit "direct" — still honoured', () => {
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
// v1.6.0 Phase 1 — spawnLocalPty: direct mode regression guard
// (Phase 7: 'direct' is still fully supported via explicit KV flag)
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

  it('treats omitted spawnMode as direct in spawnLocalPty (field-level default)', () => {
    // Phase 7 note: the KV-layer default is now 'shell-first' (parseSpawnMode).
    // However, spawnLocalPty's mode guard treats a missing/undefined
    // spawnMode field as NOT matching 'shell-first', so it falls through to
    // direct mode. In practice the KV layer always supplies an explicit mode
    // after Phase 7, so this code path is not exercised in production.
    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'absolutely-not-a-real-cli-no-mode',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        // spawnMode intentionally omitted (undefined)
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
    if (process.platform === 'win32') return; // covered by the Windows suite below
    vi.useFakeTimers();

    const { freshSpawn, written, nodePty } = await setup();

    // H-9: shell-first now pre-flights the command against PATH (mirroring
    // direct mode) so a missing binary throws ENOENT and the launcher walks to
    // the next alt. Use `sh` here — guaranteed present on POSIX — so this
    // injection test is deterministic regardless of which agent CLIs are
    // installed on the host/CI runner.
    const handle = freshSpawn({
      command: 'sh',
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

    // The spawned command should be the default shell, NOT the input command.
    const spawnCalls = vi.mocked(nodePty.spawn).mock.calls;
    expect(spawnCalls.length).toBe(1);
    const spawnedCmd = spawnCalls[0]![0] as string;
    const shellBasename = spawnedCmd.split('/').pop() ?? spawnedCmd;
    const knownShells = ['zsh', 'bash', 'sh', 'fish', 'dash'];
    const isShell = knownShells.some((s) => shellBasename.startsWith(s));
    expect(isShell).toBe(true);
  });

  it('injects the command line (with sentinel) after the first onData chunk', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written, fireData } = await setup();

    freshSpawn({
      command: 'sh',
      args: ['--resume', 'abc-123'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    expect(written.length).toBe(0);
    fireData('% ');

    expect(written.length).toBe(1);
    // Phase 2: injected line now includes the sentinel snippet so the shell
    // prints the exit marker when the CLI exits.
    const injected = written[0]!;
    expect(injected).toMatch(/^sh '--resume' 'abc-123'/);
    expect(injected).toContain(SENTINEL_PREFIX);
    expect(injected).toContain(SENTINEL_SUFFIX);
    expect(injected).toContain('"$?"');
    expect(injected.endsWith('\n')).toBe(true);
  });

  it('double-inject guard: second onData does not re-write', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written, fireData } = await setup();

    freshSpawn({
      command: 'sh',
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

  it('fallback timer writes the command (with sentinel) if no onData arrives within 250 ms', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written } = await setup();

    freshSpawn({
      command: 'sh',
      args: ['--flag'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      spawnMode: 'shell-first',
    });

    expect(written.length).toBe(0);
    vi.advanceTimersByTime(251);

    expect(written.length).toBe(1);
    const injected = written[0]!;
    expect(injected).toMatch(/^sh '--flag'/);
    expect(injected).toContain(SENTINEL_PREFIX);
    expect(injected).toContain(SENTINEL_SUFFIX);
    expect(injected.endsWith('\n')).toBe(true);
  });

  it('fallback timer does not double-inject if onData already fired', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();

    const { freshSpawn, written, fireData } = await setup();

    freshSpawn({
      command: 'sh',
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

  it('win32: shell-first still throws ENOENT for a missing command', () => {
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
    // Shell-first preserves the synchronous pre-flight contract so provider
    // launchers can still walk their alternate-command list.
    const e = caught as NodeJS.ErrnoException;
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('ENOENT');
  });

  it('H-9: shell-first throws synchronous ENOENT for a missing binary (drives the launcher alt-command walk)', () => {
    // Empty PATH so no binary resolves. Previously shell-first injected the
    // command into a live shell, so a missing binary produced only "command
    // not found" output + sentinel — never a synchronous throw — and the
    // launcher's [command, ...altCommands] walk was dead in this mode.
    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'definitely-not-a-real-binary-xyz',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
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
// H-6 (Wave-2 hardening) — win32 shell-first sentinel consistency.
//
// resolveEffectiveSpawnMode is the SINGLE source of truth shared by spawnLocalPty
// (shell-wrap decision) and PtyRegistry.create (sentinel-watch decision). These
// tests pin cross-platform shell-first parity so the two can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectiveSpawnMode (H-6)', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('non-win32: shell-first + non-empty command → shell-first', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveEffectiveSpawnMode('shell-first', 'claude')).toBe('shell-first');
  });

  it('non-win32: empty command → direct (opening a plain shell)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(resolveEffectiveSpawnMode('shell-first', '')).toBe('direct');
  });

  it('non-win32: direct request → direct', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveEffectiveSpawnMode('direct', 'claude')).toBe('direct');
    expect(resolveEffectiveSpawnMode(undefined, 'claude')).toBe('direct');
  });

  it('win32: shell-first request remains shell-first when pwsh resolves from PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (candidate) => candidate === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );

    expect(resolveEffectiveSpawnMode('shell-first', 'claude', {
      PATH: 'C:\\Program Files\\PowerShell\\7',
      PATHEXT: '.EXE',
    })).toBe('shell-first');
  });

  it('win32: cmd-only environments downgrade shell-first to direct', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (candidate) => candidate === 'C:\\cmd-only\\cmd.exe',
    );

    expect(resolveEffectiveSpawnMode('shell-first', 'claude', {
      PATH: 'C:\\cmd-only',
      PATHEXT: '.EXE',
    })).toBe('direct');
  });

  it('win32: resolved .cmd without a same-basename .ps1 downgrades to direct', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-mode-no-ps1-'));
    fs.writeFileSync(path.join(tempDir, 'pwsh.exe'), '');
    fs.writeFileSync(path.join(tempDir, 'claude.cmd'), '');

    try {
      expect(resolveEffectiveSpawnMode('shell-first', 'claude', {
        PATH: tempDir,
        PATHEXT: '.CMD;.EXE',
      })).toBe('direct');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('spawnLocalPty: win32 shell-first consistency (H-6)', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('simulated win32 + shell-first preserves synchronous ENOENT pre-flight', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = '';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'not-a-real-binary-xyz',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
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
// v1.6.0 Phase 2 — buildShellCommandLine sentinel injection
// ─────────────────────────────────────────────────────────────────────────────

describe('buildShellCommandLine (Phase 2)', () => {
  it('without sentinel: returns plain "command args\\n" (Phase 1 format)', () => {
    const line = buildShellCommandLine('claude', ['--flag', 'value']);
    expect(line).toBe("claude '--flag' 'value'\n");
  });

  it('with sentinel: command line ends with newline', () => {
    const line = buildShellCommandLine('claude', ['--flag'], true);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('with sentinel: contains the sentinel prefix and suffix', () => {
    const line = buildShellCommandLine('claude', ['--resume', 'abc'], true);
    expect(line).toContain(SENTINEL_PREFIX);
    expect(line).toContain(SENTINEL_SUFFIX);
  });

  it('with sentinel: sentinel snippet follows the command args', () => {
    const line = buildShellCommandLine('claude', ['--flag'], true);
    // Command args come before the sentinel
    const argEnd = line.indexOf("'--flag'") + "'--flag'".length;
    const sentinelStart = line.indexOf(SENTINEL_PREFIX);
    expect(sentinelStart).toBeGreaterThan(argEnd);
  });

  it('with sentinel: uses $? so shell substitutes exit code', () => {
    const line = buildShellCommandLine('mybin', [], true);
    expect(line).toContain('"$?"');
  });

  it('direct mode: buildShellCommandLine without sentinel has NO sentinel prefix', () => {
    const line = buildShellCommandLine('claude', ['--flag']);
    expect(line).not.toContain(SENTINEL_PREFIX);
    expect(line).not.toContain(SENTINEL_SUFFIX);
  });

  it('no-args case: direct mode produces "command\\n"', () => {
    const line = buildShellCommandLine('myshell', []);
    expect(line).toBe('myshell\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 5 / H-6 — win32 shell-first runtime coverage.
//
// NOTE: This test uses vi.doMock + dynamic import to mock node-pty on win32.
// The wrapped-shell spawn assertions run on Windows because command resolution
// intentionally follows Windows filesystem and PATH semantics.
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnLocalPty: win32 shell-first mode (Phase 5)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setupWin32() {
    const written: string[] = [];
    let dataHandler: ((d: string) => void) | null = null;

    const mockProc = {
      pid: 99999,
      write: (d: string) => { written.push(d); },
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (cb: (d: string) => void) => { dataHandler = cb; },
      onExit: vi.fn(),
    };

    vi.resetModules();
    vi.doMock('node-pty', () => ({
      spawn: vi.fn(() => mockProc),
    }));

    const { spawnLocalPty: freshSpawn } = await import('./local-pty');
    const nodePty = await import('node-pty');

    return {
      freshSpawn,
      nodePty,
      written,
      fireData: (chunk: string) => { dataHandler?.(chunk); },
    };
  }

  it('win32 shell-first spawns PowerShell and injects the CLI with an exit sentinel', async () => {
    if (process.platform !== 'win32') return;
    vi.useFakeTimers();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-shell-first-'));
    const shellPath = path.join(tempDir, 'pwsh.exe');
    fs.writeFileSync(shellPath, '');
    fs.writeFileSync(path.join(tempDir, 'claude.cmd'), '@echo must not be parsed\r\n');
    fs.writeFileSync(path.join(tempDir, 'claude.ps1'), '');

    try {
      const { freshSpawn, nodePty, written, fireData } = await setupWin32();
      freshSpawn({
        command: 'claude',
        args: ['--flag'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: tempDir,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
      });

      const [spawnCommand, spawnArgs, spawnOptions] = vi.mocked(nodePty.spawn).mock.calls[0]!;
      expect(path.normalize(String(spawnCommand))).toBe(path.normalize(shellPath));
      expect(spawnArgs).toEqual(['-NoLogo']);
      expect(written).toHaveLength(0);
      const spawnEnv = spawnOptions.env as Record<string, string>;
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND).toContain('/d /s /c');
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND).toContain('-NoProfile');
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND).toContain('-ExecutionPolicy');
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND).toContain('-File');
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND.toLowerCase()).toContain('claude.ps1');
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND.toLowerCase()).not.toContain('claude.cmd');

      fireData('PS> ');

      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(
        /^cmd\.exe --% %SIGMALINK_SHELL_FIRST_COMMAND%\r/,
      );
      expect(written[0]).not.toContain('\n');
      expect(written[0]).toContain(SENTINEL_PREFIX);
      expect(written[0]).toContain(SENTINEL_SUFFIX);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('round-trips adversarial arguments through an npm .cmd shim without injection', async () => {
    if (process.platform !== 'win32') return;
    vi.useFakeTimers();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-argv-shim-'));
    const commandName = 'sigmalink-argv-probe';
    fs.writeFileSync(
      path.join(tempDir, `${commandName}.cmd`),
      '@ECHO off\r\nECHO This sibling batch shim must not run.\r\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, `${commandName}.ps1`),
      [
        '#!/usr/bin/env pwsh',
        '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
        '$ret=0',
        '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($args)))',
        'exit $ret',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const payloads = [
      'x" & echo SIGMA_INJECTED & rem "',
      '100%',
      'hello!',
      '$env:PATH',
      'a|b<c>d^e(f){g}',
      'trailing\\',
      'quote\\"after',
      'line1\r\nline2',
    ];
    const expectedPayloads = [...payloads.slice(0, -1), 'line1 line2'];
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error('SystemRoot is required for this Windows test');
    const controlledEnv: NodeJS.ProcessEnv = {
      SystemRoot: systemRoot,
      ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
      PATH: `${tempDir};${path.join(systemRoot, 'System32')}`,
      PATHEXT: '.CMD;.EXE',
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };

    try {
      const { freshSpawn, nodePty, written, fireData } = await setupWin32();
      freshSpawn({
        command: commandName,
        args: payloads,
        cwd: process.cwd(),
        env: controlledEnv,
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
      });

      const [spawnCommand, , spawnOptions] = vi.mocked(nodePty.spawn).mock.calls[0]!;
      const spawnEnv = spawnOptions.env as NodeJS.ProcessEnv;
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND?.toLowerCase()).toContain(
        `${commandName}.ps1`,
      );
      expect(spawnEnv.SIGMALINK_SHELL_FIRST_COMMAND?.toLowerCase()).not.toContain(
        `${commandName}.cmd`,
      );
      fireData('PS> ');
      expect(written).toHaveLength(1);

      const output = execFileSync(
        String(spawnCommand),
        ['-NoLogo', '-NoProfile', '-Command', written[0]!],
        {
          encoding: 'utf8',
          env: spawnEnv,
        },
      );
      const extracted = extractSentinel(output);

      expect(extracted).not.toBeNull();
      expect(JSON.parse(extracted!.strippedData.trim())).toEqual(expectedPayloads);
      expect(extracted!.exitCode).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('win32 .cmd without sibling .ps1 downgrades to direct even when PowerShell exists', async () => {
    if (process.platform !== 'win32') return;
    vi.useFakeTimers();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-shell-first-no-ps1-'));
    fs.writeFileSync(path.join(tempDir, 'pwsh.exe'), '');
    fs.writeFileSync(path.join(tempDir, 'claude.cmd'), '');
    const injectionPayload = 'x" & echo SIGMA_INJECTED & rem "';

    try {
      const { freshSpawn, nodePty, written, fireData } = await setupWin32();
      freshSpawn({
        command: 'claude',
        args: [injectionPayload],
        cwd: process.cwd(),
        env: {
          PATH: tempDir,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
      });

      const [spawnCommand, spawnArgs] = vi.mocked(nodePty.spawn).mock.calls[0]!;
      expect(spawnCommand).toBe('cmd.exe');
      expect(typeof spawnArgs).toBe('string');
      expect(String(spawnArgs)).toContain('/d /s /c');
      expect(String(spawnArgs)).not.toContain('/v:on');
      expect(String(spawnArgs)).not.toContain(injectionPayload);

      fireData('C:\\> ');
      vi.advanceTimersByTime(251);

      expect(written).toHaveLength(0);
      expect(written.join('')).not.toContain('SIGMA_INJECTED');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('win32 direct mode: still throws ENOENT for missing commands', () => {
    // Explicit direct mode still takes the direct pre-flight path.
    // This verifies the invariant is preserved on win32 when spawnMode is 'direct'.
    process.env.PATH = '/does/not/exist';
    let caught: unknown = null;
    try {
      spawnLocalPty({
        command: 'not-a-real-binary-win32-direct',
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
});

describe('defaultShell', () => {
  it('honours the caller-supplied env on darwin (was: read process.env.SHELL)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(defaultShell({ SHELL: '/opt/custom/fish' })).toEqual({
      command: '/opt/custom/fish',
      args: ['-l'],
    });
  });

  it('win32: ignores env.SHELL entirely and probes pwsh → powershell → cmd', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    const r = defaultShell({
      SHELL: '/usr/bin/bash', // git-bash export — must NOT be used (ENOENT on win32)
      PATH: 'C:\\Program Files\\PowerShell\\7',
      PATHEXT: '.EXE',
    });
    expect(r).toEqual({
      command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
    });
  });

  it('win32: resolves built-in Windows PowerShell from SystemRoot when PATH omits it', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const canonicalPowerShell =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (candidate) => candidate === canonicalPowerShell,
    );

    expect(defaultShell({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\cmd-only',
      PATHEXT: '.EXE',
    })).toEqual({
      command: canonicalPowerShell,
      args: ['-NoLogo'],
    });
  });
});

describe.skipIf(process.platform !== 'win32')('spawnLocalPty Windows ConPTY integration', () => {
  it('returns to the persistent PowerShell after one Ctrl+C', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-ctrl-c-'));
    const commandName = 'sigmalink-ctrl-c-probe';
    const readyMarker = '__SIGMALINK_PROBE_CHILD_READY__';
    const shellMarker = '__SIGMALINK_PROBE_SHELL_READY__';
    const escapeControl = String.fromCharCode(27);
    const bellControl = String.fromCharCode(7);
    const oscSequence = new RegExp(
      `${escapeControl}\\][^${bellControl}]*(?:${bellControl}|${escapeControl}\\\\)`,
      'g',
    );
    const csiSequence = new RegExp(`${escapeControl}\\[[0-?]*[ -/]*[@-~]`, 'g');
    const nodePath = process.execPath.replace(/'/g, "''");
    fs.writeFileSync(
      path.join(tempDir, `${commandName}.cmd`),
      '@echo this batch shim must not run\r\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, `${commandName}.ps1`),
      [
        `Write-Output '${readyMarker}'`,
        `& '${nodePath}' -e 'setTimeout(() => {}, 30000)'`,
        'exit $LASTEXITCODE',
        '',
      ].join('\r\n'),
      'utf8',
    );

    const handle = spawnLocalPty({
      command: commandName,
      args: [],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      cols: 120,
      rows: 30,
      spawnMode: 'shell-first',
    });

    let output = '';
    let interruptSent = false;
    let sentinelCode: number | null = null;
    let shellMarkerSeen = false;
    let explicitExitSent = false;
    let exited = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Windows shell-first Ctrl+C probe timed out:\n${output}`));
        }, 30_000);

        handle.onData((chunk) => {
          output += chunk;
          const normalized = output
            .replace(oscSequence, '')
            .replace(csiSequence, '')
            .replace(/\r/g, '');

          if (!interruptSent && output.includes(readyMarker)) {
            interruptSent = true;
            setTimeout(() => handle.write('\x03'), 200);
          }

          const sentinel = extractSentinel(output);
          if (sentinelCode === null && sentinel) {
            sentinelCode = sentinel.exitCode;
            setTimeout(() => handle.write(`Write-Output "${shellMarker}"\r`), 200);
          }

          if (
            !shellMarkerSeen &&
            new RegExp(`(?:^|\\n)${shellMarker}(?:\\n|$)`).test(normalized)
          ) {
            shellMarkerSeen = true;
            setTimeout(() => {
              explicitExitSent = true;
              handle.write('exit\r');
            }, 100);
          }
        });

        handle.onExit(() => {
          exited = true;
          clearTimeout(timeout);
          resolve();
        });
      });

      expect(interruptSent).toBe(true);
      expect(sentinelCode).toBe(130);
      expect(shellMarkerSeen).toBe(true);
      expect(explicitExitSent).toBe(true);
      expect(output).not.toMatch(/Terminate batch job/i);
    } finally {
      if (!exited) handle.kill();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 35_000);
});

describe('defaultShell on linux', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('uses SHELL when it is POSIX-compatible', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(defaultShell({ SHELL: '/usr/bin/zsh' })).toEqual({ command: '/usr/bin/zsh', args: ['-l'] });
  });

  it('falls back to bash when SHELL is fish', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(defaultShell({ SHELL: '/usr/bin/fish' })).toEqual({ command: '/bin/bash', args: ['-l'] });
  });
});
