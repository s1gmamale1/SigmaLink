// Cross-platform spawn helper for Sigma Assistant and other non-PTY consumers.
//
// On POSIX (macOS / Linux) Node's child_process.spawn calls execvp which
// resolves shebangs and handles absolute paths natively — pass-through.
//
// On Windows, npm CLI shims are .cmd files. child_process.spawn with a bare
// arg array calls CreateProcessW which does NOT understand .cmd / .bat as an
// executable format, producing ENOENT even when the file exists on disk. We
// mirror the same wrapping logic that local-pty.ts:platformAwareSpawnArgs()
// uses for ConPTY launches:
//   .cmd / .bat  -> cmd.exe /d /s /c <resolved> <args>
//   .ps1         -> powershell.exe -NoProfile -ExecutionPolicy Bypass -File <resolved> <args>
//   .exe or bare -> spawn resolved path directly
//
// IMPORTANT: resolveWindowsCommand() does NOT gate on process.platform, so
// this module must branch on process.platform === 'win32' itself.

import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildWindowsSpawnArgs } from './windows-spawn';

/**
 * Build the effective [bin, args] pair for spawning `cmd` with `args` on the
 * current platform.
 *
 * - Non-Windows: returns [cmd, args] unchanged.
 * - Windows: resolves extensionless commands via PATH+PATHEXT, then wraps
 *   .cmd/.bat through cmd.exe and .ps1 through powershell.exe.
 *
 * Exported for unit testing.
 */
export function buildSpawnArgs(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { bin: string; argv: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== 'win32') {
    return { bin: cmd, argv: args };
  }

  // Resolve against the SAME env the child will run with (PATH/PATHEXT) so a
  // command that lives only in the caller's custom PATH is still found.
  const resolved = buildWindowsSpawnArgs(cmd, args, env);
  return {
    bin: resolved.command,
    argv: resolved.args,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  };
}

/**
 * Platform-aware drop-in for child_process.spawn.
 *
 * On POSIX this is a thin pass-through. On Windows it routes .cmd/.bat shims
 * through cmd.exe and .ps1 scripts through powershell.exe so that npm CLI
 * shims (e.g. claude.cmd, npx.cmd) are executable without `shell: true`.
 *
 * Never sets shell: true — callers that pass arbitrary user text as args
 * would be exposed to command injection. The wrapping is done at the argv
 * level only.
 */
export function spawnExecutable(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const { bin, argv, windowsVerbatimArguments } = buildSpawnArgs(cmd, args, opts.env ?? process.env);
  // A `cmd.exe /d /s /c "<inner>"` wrap must be passed verbatim so child_process
  // does not re-quote (and thereby break) the pre-escaped inner command line.
  const effectiveOpts: SpawnOptions = windowsVerbatimArguments
    ? { ...opts, windowsVerbatimArguments: true }
    : opts;
  return spawn(bin, argv, effectiveOpts) as ChildProcessWithoutNullStreams;
}
