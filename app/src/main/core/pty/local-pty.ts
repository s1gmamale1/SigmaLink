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
import { buildSentinelSnippet, buildPowerShellSentinelSnippet, buildCmdSentinelSnippet } from './sentinel';
import {
  buildWindowsSpawnArgs,
  resolveWindowsCommand as resolveWindowsCommandForEnv,
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
   *               Windows uses PowerShell when available, then cmd.exe.
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
 * not a Win32 path → ENOENT) — it probes pwsh → powershell → cmd.
 * Exported for the rpc scratch-shell seam + unit tests.
 */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    // Prefer pwsh (PowerShell 7+) when available, then powershell.exe (Windows
    // PowerShell 5), then cmd.exe. BUG-W7-007: pass `-NoLogo` so the upgrade
    // banner does not clutter every fresh pane. The matching env var
    // `POWERSHELL_UPDATECHECK=Off` is set in `spawnLocalPty` below.
    const pwsh = resolveWindowsCommand('pwsh.exe', env) ?? resolveWindowsCommand('pwsh', env);
    if (pwsh) return { command: pwsh, args: ['-NoLogo'] };
    const powershell =
      resolveWindowsCommand('powershell.exe', env) ?? resolveWindowsCommand('powershell', env);
    if (powershell) return { command: powershell, args: ['-NoLogo'] };
    const cmdExe = resolveWindowsCommand('cmd.exe', env) ?? 'cmd.exe';
    // Delayed expansion lets the injected sentinel capture the foreground
    // command's ERRORLEVEL after it exits. /d avoids AutoRun command pollution.
    return { command: cmdExe, args: ['/d', '/v:on'] };
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
 * to its PowerShell or cmd.exe builder instead.
 */
export function buildShellCommandLine(command: string, args: string[], withSentinel = false): string {
  const parts = [command, ...args.map(posixQuoteArg)];
  const base = parts.join(' ');
  if (withSentinel) {
    return base + buildSentinelSnippet() + '\n';
  }
  return base + '\n';
}

// ---------------------------------------------------------------------------
// v1.6.0 Phase 5 — win32 shell-first helpers.
// ---------------------------------------------------------------------------

/**
 * Win32 command-line argument quoting for PowerShell.
 *
 * PowerShell accepts two forms: single-quoted literals and double-quoted
 * strings. We use double-quoted strings (easier to compose with variable
 * expansion). Inside double quotes the only characters that need escaping are:
 *   `  (backtick — PowerShell's escape char) → ``
 *   "  (double quote) → `"
 *   $  (variable expansion) → `$
 *   (  )  { }  (subexpressions) → `` -prefixed  (`(  etc.)
 *
 * For safe literal-value quoting (no variable expansion desired), we escape
 * ALL $ signs so that a value like `--apikey=$MY_KEY` does not expand $MY_KEY
 * in the caller's PowerShell context.
 *
 * Examples:
 *   win32QuotePwshArg('hello')        → '"hello"'
 *   win32QuotePwshArg('say hello')    → '"say hello"'
 *   win32QuotePwshArg('--key=$FOO')   → '"--key=`$FOO"'
 *   win32QuotePwshArg('he said "hi"') → '"he said `"hi`""'
 */
export function win32QuotePwshArg(arg: string): string {
  const escaped = arg
    .replace(/`/g, '``')       // backtick first (it's the escape char itself)
    .replace(/"/g, '`"')       // double quote
    .replace(/\$/g, '`$')      // dollar sign (prevent variable expansion)
    .replace(/\(/g, '`(')      // open paren (subexpression)
    .replace(/\)/g, '`)')      // close paren
    .replace(/\{/g, '`{')      // open brace
    .replace(/\}/g, '`}');     // close brace
  return `"${escaped}"`;
}

/**
 * Win32 command-line argument quoting for cmd.exe.
 *
 * cmd.exe's quoting rules are notoriously complex. The safest portable
 * approach for passing literal values is to:
 *   1. Wrap the argument in double quotes.
 *   2. Escape any double quotes inside with `\"` (backslash-quote).
 *   3. Escape percent signs (`%`) with `%%` to prevent variable expansion.
 *   4. Escape `!` with `^!` to prevent delayed-expansion interpretation
 *      (harmless even when DELAYEDEXPANSION is off).
 *   5. Escape cmd meta-characters (`& | < > ^ ( ) @ ~`) that are not inside
 *      quotes in some contexts with `^` — inside double-quoted strings these
 *      are safe WITHOUT further escaping, with the exception of `"` itself
 *      (handled above).
 *
 * Inside double-quoted strings, most cmd meta-characters lose their special
 * meaning. The residual risk is with `"` (already handled) and `%`/`!`
 * (variable expansion, handled above). This is sufficient for the literal
 * CLI-arg use case.
 *
 * Examples:
 *   win32QuoteCmdArg('hello')         → '"hello"'
 *   win32QuoteCmdArg('say hello')     → '"say hello"'
 *   win32QuoteCmdArg('--key=%FOO%')   → '"--key=%%FOO%%"'
 *   win32QuoteCmdArg('he said "hi"')  → '"he said \\"hi\\""'
 */
export function win32QuoteCmdArg(arg: string): string {
  const escaped = arg
    .replace(/%/g, '%%')         // percent — prevent variable expansion
    .replace(/!/g, '^!')          // exclamation — prevent delayed expansion
    .replace(/"/g, '\\"');        // double quote — literal quote inside string
  return `"${escaped}"`;
}

/**
 * Build the command line to inject into a win32 PowerShell PTY in shell-first
 * mode.
 *
 * Quotes each argument with `win32QuotePwshArg` and optionally appends the
 * PowerShell sentinel snippet so the shell emits the exit-code marker when the
 * CLI exits.
 *
 * Pure command construction is cross-platform unit-tested; Windows tests also
 * execute the emitted sentinel in a real PowerShell process.
 *
 * The caller appends `\n` (the Enter keystroke).
 */
export function buildWin32PwshCommandLine(command: string, args: string[], withSentinel = false): string {
  const parts = [command, ...args.map(win32QuotePwshArg)];
  const base = parts.join(' ');
  if (withSentinel) {
    return base + buildPowerShellSentinelSnippet() + '\n';
  }
  return base + '\n';
}

/**
 * Build the command line to inject into a win32 cmd.exe PTY in shell-first
 * mode.
 *
 * Quotes each argument with `win32QuoteCmdArg` and optionally appends the
 * cmd.exe sentinel snippet so the shell emits the exit-code marker when the
 * CLI exits.
 *
 * Pure command construction is cross-platform unit-tested; Windows tests also
 * execute the emitted sentinel in a real delayed-expansion cmd.exe process.
 *
 * The caller appends `\n`.
 */
export function buildWin32CmdCommandLine(command: string, args: string[], withSentinel = false): string {
  const parts = [command, ...args.map(win32QuoteCmdArg)];
  const base = parts.join(' ');
  if (withSentinel) {
    return base + buildCmdSentinelSnippet() + '\n';
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
 * The two conditions required for shell-first:
 *   1. spawnMode === 'shell-first'   (operator opt-in / Phase-7 default)
 *   2. command !== ''                (launching a CLI, not just opening a shell)
 *
 * Centralising the decision here guarantees the wrapping and the watching can
 * never disagree again across macOS, Linux, and Windows.
 */
export function resolveEffectiveSpawnMode(
  spawnMode: 'direct' | 'shell-first' | undefined,
  command: string,
): 'direct' | 'shell-first' {
  return spawnMode === 'shell-first' && command !== ''
    ? 'shell-first'
    : 'direct';
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
  const effectiveMode = resolveEffectiveSpawnMode(input.spawnMode, input.command);

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
// Phase 5: win32 now supported. The command-line builder is selected based on
// the default shell resolved for win32 (PowerShell vs cmd.exe), mirroring the
// POSIX, PowerShell, and cmd.exe sentinel/quoting paths.
// ---------------------------------------------------------------------------
const SHELL_FIRST_PROMPT_TIMEOUT_MS = 250;

/**
 * Classify the win32 default shell for command-line building purposes.
 * Returns 'pwsh' if the command resolves to a PowerShell family executable,
 * 'cmd' otherwise (covers cmd.exe and unknown shells).
 */
function win32ShellKind(command: string): 'pwsh' | 'cmd' {
  return isPowerShell(command) ? 'pwsh' : 'cmd';
}

/**
 * Build the command line to inject into the PTY master for the given shell.
 * Dispatches to the per-shell builder based on platform + shell kind.
 */
function buildCommandLineForShell(
  shellCommand: string,
  command: string,
  args: string[],
  withSentinel: boolean,
): string {
  if (process.platform === 'win32') {
    const kind = win32ShellKind(shellCommand);
    if (kind === 'pwsh') {
      return buildWin32PwshCommandLine(command, args, withSentinel);
    }
    return buildWin32CmdCommandLine(command, args, withSentinel);
  }
  return buildShellCommandLine(command, args, withSentinel);
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
  // launcher walks to the next alt-command in BOTH modes. On a hit we inject the
  // original command and let the durable shell resolve it through the same env.
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

  const shell = defaultShell(baseEnv);

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

  // Compose the command line to inject.
  // Phase 2/5: pass withSentinel=true so the shell prints the exit-code
  // sentinel after the CLI exits.  The registry's onData path strips it from
  // the forwarded data and emits the 'cli-exited' signal.
  // Phase 5: dispatches to the per-shell builder (POSIX printf / PowerShell
  // Write-Host / cmd.exe echo) based on platform and resolved shell kind.
  //
  // H-9: we inject `input.command` (the bare candidate name), NOT the resolved
  // absolute path. By the time we reach here for a given candidate, the launcher
  // has already substituted the correct alt-command into `input.command` and our
  // pre-flight above confirmed it exists on PATH — the shell resolves the same
  // name to the same binary. Keeping the bare name preserves the injected-line
  // contract (and avoids leaking absolute paths into the visible terminal). The
  // pre-flight's ENOENT throw is what actually drives the fallback walk: a
  // missing candidate now fails synchronously in shell-first mode just like in
  // direct mode, so the launcher tries the next alt in both.
  const commandLine = buildCommandLineForShell(shell.command, input.command, input.args, true);

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
