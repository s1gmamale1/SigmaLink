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

export interface SpawnInput {
  command: string;          // empty string means: open user's default shell
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface PtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): () => void;
}

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

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
export function resolveWindowsCommand(cmd: string): string | null {
  if (!cmd) return null;
  // Already absolute? Trust the caller, but only if it actually exists.
  if (path.isAbsolute(cmd)) {
    if (fs.existsSync(cmd)) return cmd;
    // Maybe missing extension on an absolute path.
    if (path.extname(cmd) === '') {
      const exts = (process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT).split(';').filter(Boolean);
      for (const ext of exts) {
        const candidate = cmd + ext;
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
  const exts = (process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT).split(';').filter(Boolean);
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const hasExt = path.extname(cmd).length > 0;
  for (const dir of dirs) {
    const base = path.join(dir, cmd);
    if (hasExt) {
      try {
        if (fs.existsSync(base)) return base;
      } catch {
        /* skip unreadable dir */
      }
    } else {
      for (const ext of exts) {
        const candidate = base + ext;
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          /* skip unreadable dir */
        }
      }
    }
  }
  return null;
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
export function resolvePosixCommand(cmd: string): string | null {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/')) {
    // Absolute path or a path-relative command (e.g. "./tool"). Caller is
    // explicit about which file they want — only succeed if it exists.
    return fs.existsSync(cmd) ? cmd : null;
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
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

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    // Prefer pwsh (PowerShell 7+) when available, then powershell.exe (Windows
    // PowerShell 5), then cmd.exe. BUG-W7-007: pass `-NoLogo` so the upgrade
    // banner does not clutter every fresh pane. The matching env var
    // `POWERSHELL_UPDATECHECK=Off` is set in `spawnLocalPty` below.
    const pwsh = resolveWindowsCommand('pwsh.exe') ?? resolveWindowsCommand('pwsh');
    if (pwsh) return { command: pwsh, args: ['-NoLogo'] };
    const powershell =
      resolveWindowsCommand('powershell.exe') ?? resolveWindowsCommand('powershell');
    if (powershell) return { command: powershell, args: ['-NoLogo'] };
    const cmdExe = resolveWindowsCommand('cmd.exe') ?? 'cmd.exe';
    return { command: cmdExe, args: [] };
  }
  if (process.platform === 'darwin') {
    const sh = process.env.SHELL ?? '/bin/zsh';
    return { command: sh, args: ['-l'] };
  }
  const sh = process.env.SHELL ?? '/bin/bash';
  return { command: sh, args: ['-l'] };
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

function windowsExtensionFor(cmd: string): 'cmd' | 'ps1' | null {
  const ext = path.extname(cmd).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  return null;
}

/**
 * Build the spawn argv for the current platform.
 *  - non-Windows: pass through unchanged.
 *  - Windows: resolve extensionless commands via PATH+PATHEXT first, then wrap
 *    `.cmd` / `.bat` through `cmd.exe /d /s /c <resolved> <args>` and `.ps1`
 *    through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`.
 *    `.exe` is spawned directly so no extra shell process is allocated.
 */
function platformAwareSpawnArgs(input: SpawnInput): { command: string; args: string[] } {
  if (!input.command) return defaultShell();
  if (process.platform !== 'win32') return { command: input.command, args: input.args };

  // Windows: try to resolve the command against PATH+PATHEXT first. If we
  // cannot resolve we still try to spawn the literal command; node-pty's
  // failure surface is the same and the caller's error reporting handles it.
  const resolved = resolveWindowsCommand(input.command) ?? input.command;
  const kind = windowsExtensionFor(resolved);
  if (kind === 'cmd') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', resolved, ...input.args],
    };
  }
  if (kind === 'ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...input.args],
    };
  }
  return { command: resolved, args: input.args };
}

export function spawnLocalPty(input: SpawnInput): PtyHandle {
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
        ? resolveWindowsCommand(input.command)
        : resolvePosixCommand(input.command);
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

  const { command, args } = platformAwareSpawnArgs(input);
  const env: NodeJS.ProcessEnv = {
    ...(input.env ?? process.env),
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
    proc = nodePty.spawn(command, args, {
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
