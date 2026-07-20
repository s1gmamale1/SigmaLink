// Thin wrapper around node-pty.spawn with platform-aware shell resolution.
//
// Cross-platform notes:
//  * Linux/macOS — node-pty/posix uses execvp via the user's shell-resolved
//    binary lookup; PATH is honoured, no extension juggling required.
//  * Windows — ConPTY's CreateProcessW does NOT walk PATHEXT, so an
//    extensionless command like `claude` (an npm shim) fails with
//    ERROR_FILE_NOT_FOUND. We resolve the bare command against PATH+PATHEXT
//    ourselves and either spawn the resolved `.exe` directly or wrap `.cmd` /
//    `.bat` / `.ps1` shims through their interpreter.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as nodePty from 'node-pty';
import { buildSentinelSnippet, buildPowerShellSentinelSnippet } from './sentinel';
import {
  buildWindowsSpawnArgs,
  cmdEscapeArg,
  cmdEscapeCommandPath,
  resolveWindowsCommand as resolveWindowsCommandForEnv,
  windowsExtensionKind,
} from '../util/windows-spawn';

export interface SpawnInput {
  command: string;          // empty string means: open user's default shell
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /**
   * v1.6.0 — Phase 1 shell-first pane mode flag.
   *
   * 'direct':      node-pty spawns `command`
   *               directly (or the user's default shell when command is empty).
   *               BYTE-FOR-BYTE identical to pre-Phase-1 behaviour.
   *
   * 'shell-first': node-pty spawns the user's default shell instead.  After
   *               the shell emits its first data chunk (prompt) — or after a
   *               250 ms fallback timer if no data arrives — the composed
   *               command line is written once into the PTY master.
   *               Windows uses PowerShell only; environments without
   *               PowerShell conservatively resolve to direct mode.
   */
  spawnMode?: 'direct' | 'shell-first';
}

export interface PtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): () => void;
}

/**
 * Resolve a bare command against PATH + PATHEXT on Windows.
 * Returns the absolute path of the first match, or null if not found.
 *
 * Examples:
 *   resolveWindowsCommand('claude')   ->  'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
 *   resolveWindowsCommand('git')      ->  'C:\\Program Files\\Git\\cmd\\git.exe'
 *   resolveWindowsCommand('pwsh')     ->  '...pwsh.exe' or null
 *   resolveWindowsCommand('claude.cmd') -> resolves only against the literal extension
 */
export function resolveWindowsCommand(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveWindowsCommandForEnv(cmd, env);
}

/**
 * Resolve a bare command against PATH on POSIX (Linux/macOS). Returns the
 * absolute path of the first match, or null if not found.
 *
 * On POSIX, node-pty's `pty.fork` forks a helper which then `execvp`s the
 * target binary inside the child. ENOENT therefore surfaces as an
 * **asynchronous** child exit (code 127) rather than a synchronous throw —
 * the parent has no opportunity to fall back to an alternative command.
 *
 * `resolveAndSpawn` in `providers/launcher.ts` walks `[command, ...altCommands]`
 * and relies on the registry rejecting unknown commands synchronously. Doing
 * the existence check here is the smallest change that restores that contract
 * on POSIX without altering the registry's caller contract.
 */
export function resolvePosixCommand(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/')) {
    // Absolute path or a path-relative command (e.g. "./tool"). Caller is
    // explicit about which file they want — only succeed if it exists.
    return fs.existsSync(cmd) ? cmd : null;
  }
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* skip unreadable dir */
    }
  }
  return null;
}

/**
 * Resolve the user's default interactive shell for the given env.
 * win32 NEVER consults env.SHELL (git-bash exports SHELL=/usr/bin/bash —
 * not a Win32 path → ENOENT) — it probes PowerShell, then cmd.
 * Exported for the rpc scratch-shell seam + unit tests.
 */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const powershell = resolveWindowsPowerShell(env);
    if (powershell) return powershell;
    const cmdExe = resolveWindowsCommand('cmd.exe', env) ?? 'cmd.exe';
    return { command: cmdExe, args: [] };
  }
  if (process.platform === 'darwin') {
    const sh = env.SHELL ?? '/bin/zsh';
    return { command: sh, args: ['-l'] };
  }
  // Linux: only honour env.SHELL when it is a POSIX login shell (sh, bash,
  // zsh, dash, ksh). Exotic shells like fish do not accept `-l` and will fail
  // to source /etc/profile.d on session start, so fall back to bash.
  const sh = isPosixLoginShell(env.SHELL) ? env.SHELL : '/bin/bash';
  return { command: sh, args: ['-l'] };
}

/**
 * Resolve a PowerShell-family executable for Windows shell-first mode.
 *
 * PowerShell 7 is preferred when it is available on PATH. Windows PowerShell
 * is then resolved from its canonical SystemRoot location before consulting
 * PATH, so a normal supported Windows install remains available to Electron
 * even when its inherited PATH omits the WindowsPowerShell directory.
 */
function resolveWindowsPowerShell(
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | null {
  const pwsh = resolveWindowsCommand('pwsh.exe', env) ?? resolveWindowsCommand('pwsh', env);
  if (pwsh) return { command: pwsh, args: ['-NoLogo'] };

  const systemRootKey = Object.keys(env).find((key) => key.toLowerCase() === 'systemroot');
  const systemRoot = systemRootKey ? env[systemRootKey] : undefined;
  if (systemRoot) {
    const canonical = path.win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    try {
      if (fs.existsSync(canonical)) {
        return { command: canonical, args: ['-NoLogo'] };
      }
    } catch {
      /* fall through to PATH resolution */
    }
  }

  const powershell =
    resolveWindowsCommand('powershell.exe', env) ?? resolveWindowsCommand('powershell', env);
  return powershell ? { command: powershell, args: ['-NoLogo'] } : null;
}

/**
 * Return true when shellPath resolves to a POSIX login-compatible shell
 * (sh, bash, zsh, dash, or ksh). Used on Linux to guard against non-login
 * shells (e.g. fish) that do not support the `-l` flag and would fail to
 * source /etc/profile.d on session start.
 */
function isPosixLoginShell(shellPath: string | undefined): shellPath is string {
  if (!shellPath) return false;
  const base = path.basename(shellPath).toLowerCase();
  return base === 'sh' || base === 'bash' || base === 'zsh' || base === 'dash' || base === 'ksh';
}

/**
 * BUG-W7-007: Detect a PowerShell-family executable. Used to silence the
 * upgrade-check banner via the `POWERSHELL_UPDATECHECK=Off` env var. We match
 * on the executable basename only — full paths (e.g. `C:\\Program
 * Files\\PowerShell\\7\\pwsh.exe`) and bare `pwsh` are both covered. cmd.exe
 * and unix shells are unaffected.
 */
function isPowerShell(command: string): boolean {
  if (!command) return false;
  const base = path.basename(command).toLowerCase();
  return (
    base === 'pwsh' ||
    base === 'pwsh.exe' ||
    base === 'powershell' ||
    base === 'powershell.exe'
  );
}

/**
 * Return the same-basename PowerShell sibling for a resolved .cmd/.bat shim.
 *
 * npm writes sibling launchers such as `claude.cmd` and `claude.ps1`. We only
 * probe the filesystem; shim contents are never read or interpreted.
 */
function resolveSiblingPowerShellShim(resolvedCommand: string): string | null {
  if (windowsExtensionKind(resolvedCommand) !== 'cmd') return null;
  const parsed = path.win32.parse(resolvedCommand);
  const sibling = path.win32.join(parsed.dir, `${parsed.name}.ps1`);
  try {
    return fs.existsSync(sibling) ? sibling : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// v1.6.0 — Shell-first mode helpers
// ---------------------------------------------------------------------------

/**
 * KV key for the Phase 1 shell-first pane mode feature flag.
 * Value: 'shell-first' (DEFAULT as of Phase 7) | 'direct'.
 * Exported so registry.ts (and tests) can read the canonical key name.
 */
export const KV_PTY_SPAWN_MODE = 'pty.spawnMode';

/**
 * Parse the raw KV value for `pty.spawnMode`.
 *
 * Phase 7 default flip (2026-05-22): the default is now 'shell-first'.
 * An unset/absent/null/undefined key resolves to 'shell-first' so that a
 * crashed CLI leaves a live shell in the pane (the operator-requested
 * terminal-fallback behaviour). Explicit 'direct' values are still honoured.
 *
 * The default applies consistently across platforms. Operators can still
 * restore direct mode by setting the KV flag to 'direct' explicitly.
 */
export function parseSpawnMode(raw: string | null | undefined): 'direct' | 'shell-first' {
  if (raw === 'direct') return 'direct';
  return 'shell-first';
}

/**
 * v1.9-scrollback — KV key for the opt-in scrollback persistence flag.
 * Value: 'on' to enable; anything else (including absent) keeps DEFAULT OFF.
 * Exported so rpc-router.ts and tests can read the canonical key name without
 * importing the full scrollback-store.
 */
export const KV_PTY_SCROLLBACK_PERSISTENCE = 'pty.scrollbackPersistence';

/**
 * Parse the raw KV value for `pty.scrollbackPersistence`.
 * Returns false for any unrecognised or missing value — the DEFAULT is OFF.
 * CRITICAL INVARIANT: false must be the fallback for every code path.
 */
export function parseScrollbackPersistence(raw: string | null | undefined): boolean {
  return raw === 'on';
}

/**
 * Minimal POSIX single-quote shell quoting.  Each argument is wrapped in
 * single quotes with internal single quotes escaped via the classic
 * `'\''` technique.
 *
 * Examples:
 *   posixQuoteArg('hello')       → "'hello'"
 *   posixQuoteArg('say hello')   → "'say hello'"
 *   posixQuoteArg("it's fine")  → "'it'\\''s fine'"
 *
 * This is intentionally minimal — it covers every POSIX argument value
 * including spaces, double quotes, backslashes, and embedded single quotes.
 */
export function posixQuoteArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command line to inject into the PTY master in shell-first
 * mode.
 *
 * Phase 1: `"<command> <quotedArgs>\n"`
 * Phase 2 (withSentinel=true): appends `; printf '\n...' "$?" '...'` so that
 * when the CLI exits the shell prints the sentinel line before returning to its
 * prompt.  The registry's onData path strips the sentinel from the forwarded
 * data and emits the cli-exited signal.
 *
 * This builder emits the POSIX sentinel. Windows shell-first mode dispatches
 * to its PowerShell builder instead.
 */
export function buildShellCommandLine(command: string, args: string[], withSentinel = false): string {
  const parts = [command, ...args.map(posixQuoteArg)];
  const base = parts.join(' ');
  if (withSentinel) {
    return base + buildSentinelSnippet() + '\n';
  }
  return base + '\n';
}

/**
 * H-6 (Wave-2 hardening) — SINGLE source of truth for "is this spawn actually
 * wrapped in a shell (shell-first) or run directly?".
 *
 * Both `spawnLocalPty` (which decides whether to wrap the command in a shell
 * and emit the exit-code sentinel) and `PtyRegistry.create` (which decides
 * whether to arm the sentinel watcher on the data stream) MUST agree on this.
 * Previously each duplicated the 3-condition guard inline and they drifted:
 * the spawn side dropped the win32 check in Phase 5 while the registry kept it,
 * so on win32 a pane was wrapped-and-sentinelled but watched as direct.
 *
 * The conditions required for shell-first:
 *   1. spawnMode === 'shell-first'   (operator opt-in / Phase-7 default)
 *   2. command !== ''                (launching a CLI, not just opening a shell)
 *   3. win32 only: PowerShell resolves from the child environment
 *   4. win32 .cmd/.bat only: a same-basename .ps1 sibling exists
 *
 * Centralising the decision here guarantees the wrapping and the watching can
 * never disagree again across macOS, Linux, and Windows.
 */
export function resolveEffectiveSpawnMode(
  spawnMode: 'direct' | 'shell-first' | undefined,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): 'direct' | 'shell-first' {
  if (spawnMode !== 'shell-first' || command === '') return 'direct';
  if (process.platform === 'win32') {
    if (resolveWindowsPowerShell(env) === null) return 'direct';
    const resolvedCommand = resolveWindowsCommand(command, env);
    if (
      resolvedCommand !== null &&
      windowsExtensionKind(resolvedCommand) === 'cmd' &&
      resolveSiblingPowerShellShim(resolvedCommand) === null
    ) {
      return 'direct';
    }
  }
  return 'shell-first';
}

/**
 * v1.6.0 Phase 3 — Compute the effective per-pane spawn mode.
 *
 * When the global mode is 'shell-first' and this pane's provider delivers its
 * initial prompt via a post-spawn `pty.write` (i.e. has neither `oneshotArgs`
 * nor `initialPromptFlag`), that write would race the shell→CLI startup.
 * The safe-scope fix: override that pane's mode to 'direct' so the write
 * lands reliably. Other panes in the same workspace keep 'shell-first'.
 *
 * When the global mode is 'direct' this function is a no-op — returns 'direct'
 * always, keeping the CRITICAL INVARIANT that direct-mode is byte-for-byte
 * unchanged.
 *
 * Provider taxonomy:
 *   Path A (arg injection via oneshotArgs):  claude (-p), codex (-q)
 *   Path A (arg injection via initialPromptFlag): gemini (-i)
 *   Path B (post-spawn pty.write): kimi, opencode — these trigger the override
 *
 * Exported so workspaces/launcher.ts (production) and local-pty.test.ts (tests)
 * can share the same implementation without the Electron-heavy launcher module.
 */
export function effectivePaneSpawnMode(
  globalSpawnMode: 'direct' | 'shell-first',
  hasInitialPrompt: boolean,
  providerHasOneshotArgs: boolean,
  providerHasInitialPromptFlag: boolean,
): 'direct' | 'shell-first' {
  if (globalSpawnMode !== 'shell-first') return 'direct';
  const promptNeedsPostWrite =
    hasInitialPrompt && !providerHasOneshotArgs && !providerHasInitialPromptFlag;
  return promptNeedsPostWrite ? 'direct' : 'shell-first';
}

/**
 * Build the spawn argv for the current platform.
 *  - non-Windows: pass through unchanged.
 *  - Windows: resolve extensionless commands via PATH+PATHEXT first, then wrap
 *    `.cmd` / `.bat` through `cmd.exe /d /s /c <resolved> <args>` and `.ps1`
 *    through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`.
 *    `.exe` is spawned directly so no extra shell process is allocated.
 */
function platformAwareSpawnArgs(input: SpawnInput): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  const env = input.env ?? process.env;
  if (!input.command) return defaultShell(env);
  if (process.platform !== 'win32') return { command: input.command, args: input.args };

  // Windows: try to resolve the command against the same PATH/PATHEXT env that
  // will be passed to the child. This covers packaged/Electron launches where
  // the runtime PATH differs from the parent process PATH.
  return buildWindowsSpawnArgs(input.command, input.args, env);
}

export function spawnLocalPty(input: SpawnInput): PtyHandle {
  // ---------------------------------------------------------------------------
  // v1.6.0 Phase 1/5 — shell-first mode branch.
  //
  // CRITICAL INVARIANT: when spawnMode is 'direct', or when
  // input.command is empty, we take EXACTLY the existing code path below —
  // behaviour is byte-for-byte identical to pre-Phase-1.
  //
  // Phase 5: win32 shell-first is wired behind the same flag, using the
  // PowerShell/cmd quoting and sentinel builders below.
  //
  // 2-condition guard:
  //   1. spawnMode === 'shell-first'   (operator opt-in)
  //   2. command !== ''                (non-empty → launching a CLI, not just opening a shell)
  //
  // Phase 7 (DONE — 2026-05-22): default is now 'shell-first'.
  // parseSpawnMode() returns 'shell-first' for any unset/absent KV value.
  // Explicit 'direct' KV values are still honoured.
  //
  // H-6 (Wave-2 hardening): spawnLocalPty and PtyRegistry both resolve the mode
  // through the helper above, keeping shell wrapping and sentinel watching in
  // lockstep on every platform.
  // ---------------------------------------------------------------------------
  const effectiveMode = resolveEffectiveSpawnMode(
    input.spawnMode,
    input.command,
    input.env ?? process.env,
  );

  if (effectiveMode === 'shell-first') {
    return spawnShellFirstPty(input);
  }

  // ---------------------------------------------------------------------------
  // DIRECT MODE — original implementation, untouched.
  // ---------------------------------------------------------------------------
  const baseEnv = input.env ?? process.env;

  // Validate cwd up-front; ConPTY also fails with code 2 when the directory
  // does not exist, and the failure mode is indistinguishable from a missing
  // executable.
  const resolvedCwd =
    input.cwd && fs.existsSync(input.cwd) ? input.cwd : os.homedir();

  // Pre-flight ENOENT check. On POSIX, node-pty surfaces missing binaries as
  // an async exit(127) — too late for `resolveAndSpawn` to fall back to an
  // alt-command. On Windows, `platformAwareSpawnArgs` may have already
  // resolved the command via PATH+PATHEXT, but if it returned the literal
  // unresolved name we'd still hit an async ConPTY failure. Throwing a
  // synchronous ENOENT here lets the launcher's fallback walk progress.
  // An empty `input.command` means "open the user's default shell" and
  // `platformAwareSpawnArgs` already substituted a known shell — skip the
  // check in that case.
  if (input.command) {
    const resolved =
      process.platform === 'win32'
        ? resolveWindowsCommand(input.command, baseEnv)
        : resolvePosixCommand(input.command, baseEnv);
    if (!resolved) {
      const err = new Error(
        `spawn ${input.command} ENOENT`,
      ) as Error & { code: string; errno: number; syscall: string; path: string };
      err.code = 'ENOENT';
      err.errno = -2;
      err.syscall = 'spawn';
      err.path = input.command;
      throw err;
    }
  }

  const { command, args, windowsVerbatimArguments } = platformAwareSpawnArgs(input);
  // When `buildWindowsSpawnArgs` produced a verbatim `cmd.exe /d /s /c "<inner>"`
  // wrap, node-pty must NOT re-quote it. node-pty treats a STRING `args` as a
  // pre-escaped command line and concatenates it without escaping, so join the
  // argv. Array form (POSIX, .exe, .ps1) is unchanged.
  const spawnArgs: string | string[] = windowsVerbatimArguments ? args.join(' ') : args;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  };
  // BUG-W7-007: silence the "A new PowerShell stable release is available"
  // banner that PowerShell 7 prints once per pane. Only applied when the
  // resolved executable is pwsh/powershell — cmd.exe and unix shells are
  // unaffected.
  if (isPowerShell(command)) {
    env.POWERSHELL_UPDATECHECK = 'Off';
  }

  const dataSubs = new Set<(d: string) => void>();
  const exitSubs = new Set<(i: { exitCode: number; signal?: number }) => void>();

  let proc: nodePty.IPty;
  try {
    proc = nodePty.spawn(command, spawnArgs, {
      name: 'xterm-256color',
      cwd: resolvedCwd,
      cols: Math.max(20, input.cols | 0),
      rows: Math.max(5, input.rows | 0),
      env: env as { [key: string]: string },
    });
  } catch (err) {
    // Synchronous spawn failure (rare on POSIX, possible on Windows when the
    // ConPTY agent itself cannot be created). Surface it as a synthetic data
    // chunk + exit so the caller's data/exit pipeline observes it the same way
    // as a normal early death.
    const message =
      err instanceof Error ? err.message : String(err ?? 'spawn failed');
    const fakeHandle: PtyHandle = {
      pid: -1,
      write: () => {
        /* noop on a dead pty */
      },
      resize: () => {
        /* noop */
      },
      kill: () => {
        /* noop */
      },
      onData: (cb) => {
        dataSubs.add(cb);
        return () => dataSubs.delete(cb);
      },
      onExit: (cb) => {
        exitSubs.add(cb);
        return () => exitSubs.delete(cb);
      },
    };
    setImmediate(() => {
      for (const cb of dataSubs) {
        cb(`\x1b[31m${message}\x1b[0m\r\n`);
      }
      for (const cb of exitSubs) {
        cb({ exitCode: -1, signal: undefined });
      }
    });
    return fakeHandle;
  }

  proc.onData((d) => {
    for (const cb of dataSubs) cb(d);
  });
  proc.onExit(({ exitCode, signal }) => {
    for (const cb of exitSubs) cb({ exitCode, signal });
  });
  return {
    pid: proc.pid,
    write: (d) => proc.write(d),
    resize: (cols, rows) => {
      // node-pty throws `Error: ioctl(2) failed, EBADF` if the underlying file
      // descriptor was already closed (e.g. a pane that exited during the
      // 200ms graceful-exit window, then the renderer's ResizeObserver fires
      // one last time). Swallow silently like `kill` below — the IPC layer
      // would otherwise surface it as a red toast for an already-dead pane.
      try {
        proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0));
      } catch (err) {
        console.warn('[pty] resize on dead handle ignored:', err);
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => {
      dataSubs.add(cb);
      return () => dataSubs.delete(cb);
    },
    onExit: (cb) => {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
  };
}

// ---------------------------------------------------------------------------
// v1.6.0 Phase 1/5 — shell-first spawn implementation (POSIX + win32).
//
// Spawns the user's default shell as the PTY child. After the shell emits its
// first data chunk (its prompt), writes the composed command line ONCE into
// the PTY master. A 250 ms fallback timer fires if no data arrives, ensuring
// the CLI still starts even in minimal shell environments that suppress the
// prompt.
//
// Resume-arg machinery: command + args already include any resume args (they
// are composed by the launcher before reaching spawnLocalPty). shell-first
// simply writes that composed line to the shell — no extra handling needed.
//
// Phase 5: win32 shell-first is PowerShell-only. A cmd-only environment is
// downgraded to direct mode before this path is entered.
// ---------------------------------------------------------------------------
const SHELL_FIRST_PROMPT_TIMEOUT_MS = 250;
const WINDOWS_SHELL_FIRST_COMMAND_ENV = 'SIGMALINK_SHELL_FIRST_COMMAND';

/**
 * Build a cmd.exe command line for PowerShell to consume through `--%`.
 *
 * The value is stored in the PTY environment rather than interpolated into the
 * PowerShell source. PowerShell expands `%SIGMALINK_SHELL_FIRST_COMMAND%` after
 * its stop-parsing operator and does not reinterpret metacharacters from the
 * value. cmdEscapeArg then protects the cmd parse.
 *
 * Resolved npm .cmd/.bat shims run through their same-basename .ps1 sibling in
 * a transient PowerShell child. Keeping a batch file as the foreground job of
 * the persistent pane shell makes one Ctrl+C trigger cmd.exe's interactive
 * "Terminate batch job (Y/N)?" prompt.
 */
function buildWindowsShellFirstCommand(
  resolvedCommand: string,
  args: string[],
  powerShellCommand: string,
): string {
  const kind = windowsExtensionKind(resolvedCommand);
  let command = resolvedCommand;
  let commandArgs = args;
  let doubleEscape = kind === 'cmd';

  const scriptPath =
    kind === 'ps1'
      ? resolvedCommand
      : kind === 'cmd'
        ? resolveSiblingPowerShellShim(resolvedCommand)
        : null;
  if (scriptPath) {
    command = powerShellCommand;
    commandArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...args,
    ];
    doubleEscape = false;
  }

  const escapedCommand = scriptPath
    ? cmdEscapeArg(command)
    : cmdEscapeCommandPath(command);
  const inner = [
    escapedCommand,
    ...commandArgs.map((arg) => cmdEscapeArg(arg, doubleEscape)),
  ].join(' ');
  return `/d /s /c "${inner}"`;
}

function buildWindowsShellFirstScript(withSentinel: boolean): string {
  // ConPTY input is terminal input, not a PowerShell script file. PSReadLine
  // treats LF as a multiline edit; CR is the Enter key that submits each line.
  // Queue the sentinel and cleanup behind the foreground command so Ctrl+C
  // interrupts the CLI and PowerShell executes both lines after it returns.
  let script = `cmd.exe --% %${WINDOWS_SHELL_FIRST_COMMAND_ENV}%\r`;
  if (withSentinel) {
    script += buildPowerShellSentinelSnippet().replace(/^;\s*/, '') + '\r';
  }
  script += `Remove-Item Env:${WINDOWS_SHELL_FIRST_COMMAND_ENV} -ErrorAction SilentlyContinue\r`;
  return script;
}

function spawnShellFirstPty(input: SpawnInput): PtyHandle {
  // H-9 (Wave-2 hardening): synchronous ENOENT pre-flight for shell-first mode.
  //
  // In direct mode, `spawnLocalPty` pre-resolves the command against PATH and
  // throws a synchronous ENOENT when it is missing, which lets the launcher's
  // `[command, ...altCommands]` walk fall through to the next candidate. In
  // shell-first mode the binary is INJECTED as text into a shell that always
  // exists, so a missing binary used to surface only as shell "command not
  // found" output + the exit-code sentinel — never a synchronous throw — and
  // the altCommands fallback was therefore dead.
  //
  // Resolve the binary here, BEFORE building the shell command line, mirroring
  // the direct-mode pre-flight. On a miss we throw the same ENOENT shape so the
  // launcher walks to the next alt-command in BOTH modes. Windows transports
  // the resolved path through the protected child-command environment value;
  // POSIX keeps injecting the original command name.
  const baseEnv = input.env ?? process.env;
  const resolvedCommand =
    process.platform === 'win32'
      ? resolveWindowsCommand(input.command, baseEnv)
      : resolvePosixCommand(input.command, baseEnv);
  if (!resolvedCommand) {
    const err = new Error(
      `spawn ${input.command} ENOENT`,
    ) as Error & { code: string; errno: number; syscall: string; path: string };
    err.code = 'ENOENT';
    err.errno = -2;
    err.syscall = 'spawn';
    err.path = input.command;
    throw err;
  }

  const resolvedCwd =
    input.cwd && fs.existsSync(input.cwd) ? input.cwd : os.homedir();

  const shell =
    process.platform === 'win32'
      ? resolveWindowsPowerShell(baseEnv)
      : defaultShell(baseEnv);
  if (!shell) {
    throw new Error('Windows shell-first mode requires PowerShell');
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  };
  // BUG-W7-007: silence the PowerShell upgrade banner when the shell itself is
  // PowerShell (shell-first mode spawns the shell directly).
  if (isPowerShell(shell.command)) {
    env.POWERSHELL_UPDATECHECK = 'Off';
  }

  const commandLine =
    process.platform === 'win32'
      ? buildWindowsShellFirstScript(true)
      : buildShellCommandLine(input.command, input.args, true);
  if (process.platform === 'win32') {
    env[WINDOWS_SHELL_FIRST_COMMAND_ENV] = buildWindowsShellFirstCommand(
      resolvedCommand,
      input.args,
      shell.command,
    );
  }

  const dataSubs = new Set<(d: string) => void>();
  const exitSubs = new Set<(i: { exitCode: number; signal?: number }) => void>();

  let proc: nodePty.IPty;
  try {
    proc = nodePty.spawn(shell.command, shell.args, {
      name: 'xterm-256color',
      cwd: resolvedCwd,
      cols: Math.max(20, input.cols | 0),
      rows: Math.max(5, input.rows | 0),
      env: env as { [key: string]: string },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err ?? 'spawn failed');
    const fakeHandle: PtyHandle = {
      pid: -1,
      write: () => { /* noop on a dead pty */ },
      resize: () => { /* noop */ },
      kill: () => { /* noop */ },
      onData: (cb) => { dataSubs.add(cb); return () => dataSubs.delete(cb); },
      onExit: (cb) => { exitSubs.add(cb); return () => exitSubs.delete(cb); },
    };
    setImmediate(() => {
      for (const cb of dataSubs) cb(`\x1b[31m${message}\x1b[0m\r\n`);
      for (const cb of exitSubs) cb({ exitCode: -1, signal: undefined });
    });
    return fakeHandle;
  }

  // Injection latch — write the command line exactly ONCE.
  let injected = false;
  const injectCommand = () => {
    if (injected) return;
    injected = true;
    proc.write(commandLine);
  };

  // Fallback timer: if no onData arrives within 250 ms, inject anyway.
  const fallbackTimer = setTimeout(injectCommand, SHELL_FIRST_PROMPT_TIMEOUT_MS);
  // Unref so it doesn't prevent process exit in tests.
  if (fallbackTimer.unref) fallbackTimer.unref();

  proc.onData((d) => {
    // First data chunk is the shell's prompt-ready signal.
    injectCommand();
    clearTimeout(fallbackTimer);
    for (const cb of dataSubs) cb(d);
  });
  proc.onExit(({ exitCode, signal }) => {
    clearTimeout(fallbackTimer);
    for (const cb of exitSubs) cb({ exitCode, signal });
  });

  return {
    pid: proc.pid,
    write: (d) => proc.write(d),
    resize: (cols, rows) => {
      try {
        proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0));
      } catch (err) {
        console.warn('[pty] resize on dead handle ignored:', err);
      }
    },
    kill: () => {
      try {
        clearTimeout(fallbackTimer);
        proc.kill();
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => {
      dataSubs.add(cb);
      return () => dataSubs.delete(cb);
    },
    onExit: (cb) => {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
  };
}
