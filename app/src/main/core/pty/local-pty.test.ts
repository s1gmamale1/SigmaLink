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
  win32QuotePwshArg,
  win32QuoteCmdArg,
  buildWin32PwshCommandLine,
  buildWin32CmdCommandLine,
} from './local-pty';
import { SENTINEL_PREFIX, SENTINEL_SUFFIX } from './sentinel';

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
    // However, spawnLocalPty's 3-condition guard treats a missing/undefined
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
    if (process.platform === 'win32') return; // win32 falls back to direct
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

  it('H-9: shell-first throws synchronous ENOENT for a missing binary (drives the launcher alt-command walk)', () => {
    if (process.platform === 'win32') return; // POSIX path (win32 degrades to direct)
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
// tests pin the win32 coercion so the two can never disagree again.
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

  it('win32: shell-first request is coerced to direct (un-dogfooded — kept consistent end-to-end)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // Even an explicit shell-first request must yield direct on win32 so the
    // pane is NOT shell-wrapped (no sentinel emitted) AND the registry does not
    // arm a sentinel watcher. The wrap-side (spawnLocalPty) and the watch-side
    // (PtyRegistry.create) both read this helper, so they agree by construction.
    expect(resolveEffectiveSpawnMode('shell-first', 'claude')).toBe('direct');
  });
});

describe('spawnLocalPty: win32 shell-first consistency (H-6)', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('simulated win32 + shell-first request does NOT spawn shell-first (no sentinel watcher armed for a non-wrapped pane)', () => {
    // Simulate win32 and an empty PATH so the would-be command cannot resolve.
    // If win32 took the shell-first path, spawnShellFirstPty would resolve the
    // SHELL (which the win32 resolver may still find) and inject a sentinel —
    // no synchronous throw. Because win32 is coerced to DIRECT, the direct-mode
    // pre-flight runs instead and throws ENOENT for the missing command,
    // proving we took the direct path (consistent with the registry, which also
    // coerces win32 to direct and therefore arms NO sentinel watcher).
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
// v1.6.0 Phase 5 — win32QuotePwshArg (PowerShell argument quoting)
//
// Pure logic tests — runnable on any platform (macOS CI included).
// pending-Windows-dogfood: PTY e2e verification requires a Windows host.
// ─────────────────────────────────────────────────────────────────────────────

describe('win32QuotePwshArg (Phase 5)', () => {
  it('wraps a simple arg in double quotes', () => {
    expect(win32QuotePwshArg('hello')).toBe('"hello"');
  });

  it('handles args with spaces', () => {
    expect(win32QuotePwshArg('say hello')).toBe('"say hello"');
  });

  it('escapes backtick (PowerShell escape character)', () => {
    expect(win32QuotePwshArg('a`b')).toBe('"a``b"');
  });

  it('escapes double quotes with backtick', () => {
    expect(win32QuotePwshArg('he said "hi"')).toBe('"he said `"hi`""');
  });

  it('escapes dollar sign to prevent variable expansion', () => {
    expect(win32QuotePwshArg('--key=$FOO')).toBe('"--key=`$FOO"');
  });

  it('escapes parentheses (subexpression delimiters)', () => {
    // ( → `(  and  ) → `)  so (value) → `(value`) wrapped in "..."
    expect(win32QuotePwshArg('(value)')).toBe('"`(value`)"');
  });

  it('escapes braces', () => {
    // { → `{  and  } → `}  so {block} → `{block`} wrapped in "..."
    expect(win32QuotePwshArg('{block}')).toBe('"`{block`}"');
  });

  it('handles an empty arg', () => {
    expect(win32QuotePwshArg('')).toBe('""');
  });

  it('handles backslashes (no escaping needed in double-quoted strings)', () => {
    expect(win32QuotePwshArg('C:\\Users\\foo')).toBe('"C:\\Users\\foo"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 5 — win32QuoteCmdArg (cmd.exe argument quoting)
//
// Pure logic tests — runnable on any platform.
// pending-Windows-dogfood: PTY e2e verification requires a Windows host.
// ─────────────────────────────────────────────────────────────────────────────

describe('win32QuoteCmdArg (Phase 5)', () => {
  it('wraps a simple arg in double quotes', () => {
    expect(win32QuoteCmdArg('hello')).toBe('"hello"');
  });

  it('handles args with spaces', () => {
    expect(win32QuoteCmdArg('say hello')).toBe('"say hello"');
  });

  it('escapes percent signs to prevent variable expansion', () => {
    expect(win32QuoteCmdArg('--key=%FOO%')).toBe('"--key=%%FOO%%"');
  });

  it('escapes double quotes with backslash', () => {
    expect(win32QuoteCmdArg('he said "hi"')).toBe('"he said \\"hi\\""');
  });

  it('escapes exclamation marks (delayed expansion)', () => {
    expect(win32QuoteCmdArg('hello!')).toBe('"hello^!"');
  });

  it('handles an empty arg', () => {
    expect(win32QuoteCmdArg('')).toBe('""');
  });

  it('handles backslashes (no escaping needed inside double quotes for cmd)', () => {
    expect(win32QuoteCmdArg('C:\\Users\\foo')).toBe('"C:\\Users\\foo"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 5 — buildWin32PwshCommandLine (Phase 5)
//
// pending-Windows-dogfood: PTY e2e verification requires a Windows host.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWin32PwshCommandLine (Phase 5)', () => {
  it('without sentinel: produces "command <quotedArgs>\\n"', () => {
    const line = buildWin32PwshCommandLine('claude', ['--flag', 'value']);
    expect(line).toBe('claude "--flag" "value"\n');
  });

  it('with sentinel: ends with newline', () => {
    const line = buildWin32PwshCommandLine('claude', ['--flag'], true);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('with sentinel: contains the sentinel prefix and suffix', () => {
    const line = buildWin32PwshCommandLine('claude', ['--resume', 'abc'], true);
    expect(line).toContain(SENTINEL_PREFIX);
    expect(line).toContain(SENTINEL_SUFFIX);
  });

  it('with sentinel: uses $LASTEXITCODE (PowerShell exit code variable)', () => {
    const line = buildWin32PwshCommandLine('mybin', [], true);
    expect(line).toContain('$LASTEXITCODE');
  });

  it('with sentinel: uses Write-Host to emit the marker', () => {
    const line = buildWin32PwshCommandLine('mybin', [], true);
    expect(line).toContain('Write-Host');
  });

  it('without sentinel: NO sentinel prefix in output', () => {
    const line = buildWin32PwshCommandLine('claude', ['--flag']);
    expect(line).not.toContain(SENTINEL_PREFIX);
  });

  it('no-args case: produces "command\\n"', () => {
    const line = buildWin32PwshCommandLine('mybin', []);
    expect(line).toBe('mybin\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 5 — buildWin32CmdCommandLine (Phase 5)
//
// pending-Windows-dogfood: PTY e2e verification requires a Windows host.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWin32CmdCommandLine (Phase 5)', () => {
  it('without sentinel: produces "command <quotedArgs>\\n"', () => {
    const line = buildWin32CmdCommandLine('claude', ['--flag', 'value']);
    expect(line).toBe('claude "--flag" "value"\n');
  });

  it('with sentinel: ends with newline', () => {
    const line = buildWin32CmdCommandLine('claude', ['--flag'], true);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('with sentinel: contains the sentinel prefix and suffix', () => {
    const line = buildWin32CmdCommandLine('claude', ['--resume', 'abc'], true);
    expect(line).toContain(SENTINEL_PREFIX);
    expect(line).toContain(SENTINEL_SUFFIX);
  });

  it('with sentinel: uses %ERRORLEVEL% capture pattern', () => {
    const line = buildWin32CmdCommandLine('mybin', [], true);
    expect(line).toContain('%ERRORLEVEL%');
  });

  it('with sentinel: uses SET to save exit code before echo. resets it', () => {
    const line = buildWin32CmdCommandLine('mybin', [], true);
    expect(line).toContain('SET');
    expect(line).toContain('__SL_EC');
  });

  it('without sentinel: NO sentinel prefix in output', () => {
    const line = buildWin32CmdCommandLine('claude', ['--flag']);
    expect(line).not.toContain(SENTINEL_PREFIX);
  });

  it('no-args case: produces "command\\n"', () => {
    const line = buildWin32CmdCommandLine('mybin', []);
    expect(line).toBe('mybin\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 5 / H-6 — win32 shell-first helpers exist, but runtime currently
// coerces win32 shell-first requests back to direct mode until Windows dogfood
// validates the wrapped-shell sentinel path.
//
// NOTE: This test uses vi.doMock + dynamic import to mock node-pty on win32.
// On the macOS test host, we simulate the win32 platform via process.platform.
//
// pending-Windows-dogfood: full PTY integration requires a Windows host.
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

  it('on simulated win32 with shell-first: stays direct until Windows dogfood clears shell-first', async () => {
    if (process.platform !== 'win32') {
      // Simulate win32 platform on macOS by temporarily overriding process.platform.
      // H-6 restored direct mode on win32 so spawn/watch logic cannot drift.
      vi.useFakeTimers();

      const { freshSpawn, nodePty } = await setupWin32();

      // Override platform to 'win32' for this test.
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      // Ensure resolveWindowsCommand won't throw on missing PATH by giving it a real shell.
      // We rely on spawnShellFirstPty not calling resolveWindowsCommand for the shell
      // (it calls defaultShell() which already resolves).

      try {
        freshSpawn({
          command: 'claude',
          args: ['--flag'],
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          spawnMode: 'shell-first',
        });
      } catch {
        // Spawn may fail in test env on a simulated win32 platform — that's expected.
        // What we verify below is that shell-first wrapping did not happen.
      } finally {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      }

      // The spawn call, if it happened, should NOT be a shell-first wrapped
      // PowerShell/cmd launch. In most simulated environments direct-mode
      // preflight throws ENOENT before node-pty is reached.
      const spawnCalls = vi.mocked(nodePty.spawn).mock.calls;
      for (const call of spawnCalls) {
        expect(String(call[0]).toLowerCase()).not.toMatch(/powershell|pwsh|cmd\.exe/);
      }
    }
  });

  it('win32 direct mode: still throws ENOENT for missing commands', () => {
    // The 3-condition guard: spawnMode !== 'shell-first' → direct mode → ENOENT.
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
