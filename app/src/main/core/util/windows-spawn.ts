import fs from 'node:fs';
import path from 'node:path';

export const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  const foundKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return foundKey ? env[foundKey] : undefined;
}

function windowsPathEntries(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, 'PATH') ?? '').split(';').filter(Boolean);
}

function windowsPathExtEntries(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, 'PATHEXT') ?? WINDOWS_DEFAULT_PATHEXT).split(';').filter(Boolean);
}

function existingCandidate(candidate: string): string | null {
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Windows command against an explicit environment's PATH + PATHEXT.
 *
 * This intentionally uses path.win32 so unit tests can exercise Windows path
 * semantics from macOS/Linux hosts by stubbing process.platform.
 */
export function resolveWindowsCommand(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!cmd) return null;

  const ext = path.win32.extname(cmd);
  const candidatesFor = (base: string): string[] => {
    if (ext) return [base];
    return windowsPathExtEntries(env).map((candidateExt) => base + candidateExt);
  };

  if (path.win32.isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/')) {
    for (const candidate of candidatesFor(cmd)) {
      const found = existingCandidate(candidate);
      if (found) return found;
    }
    return null;
  }

  for (const dir of windowsPathEntries(env)) {
    const base = path.win32.join(dir, cmd);
    for (const candidate of candidatesFor(base)) {
      const found = existingCandidate(candidate);
      if (found) return found;
    }
  }
  return null;
}

export function windowsExtensionKind(resolved: string): 'cmd' | 'ps1' | null {
  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  return null;
}

export function cmdQuoteArg(arg: string): string {
  const escaped = arg
    .replace(/\^/g, '^^')
    .replace(/%/g, '^%')
    .replace(/!/g, '^!')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface BuiltWindowsSpawn {
  command: string;
  args: string[];
  /**
   * When `true`, the caller MUST hand `args` to its spawn layer VERBATIM — i.e.
   * the spawn layer must NOT apply its own Win32 argument quoting:
   *   • child_process.spawn → pass `windowsVerbatimArguments: true` in options
   *     (and forward it through wrappers such as `execCmd`).
   *   • node-pty.spawn      → pass `args.join(' ')` as a single command-line
   *     string (node-pty treats a string as a pre-escaped command line).
   *
   * The `cmd.exe` branch below pre-quotes every token via `cmdQuoteArg` and then
   * wraps the whole inner line in an OUTER pair of quotes that `cmd /d /s /c`
   * strips verbatim. If the spawn layer re-quotes instead, it escapes the inner
   * quotes (`"` → `\"`); cmd.exe cannot parse `\"`, so it treats the program
   * path as garbage and reports `'…' is not recognized as an internal or
   * external command` and exits 1. That regression broke 100% of agent panes
   * on Windows (every CLI is installed as a `.cmd` shim). See windows-spawn.test.ts.
   */
  windowsVerbatimArguments?: boolean;
}

export function buildWindowsSpawnArgs(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): BuiltWindowsSpawn {
  const resolved = resolveWindowsCommand(cmd, env) ?? cmd;
  const kind = windowsExtensionKind(resolved);

  if (kind === 'cmd') {
    // Each token is individually cmd-quoted; the whole line is then wrapped in
    // an OUTER pair of quotes so `cmd /d /s /c "<inner>"` strips exactly that
    // pair and runs the inner line verbatim. The result MUST be passed to the
    // spawn layer without re-quoting — see `windowsVerbatimArguments`.
    const inner = [resolved, ...args].map(cmdQuoteArg).join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (kind === 'ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
    };
  }
  return { command: resolved, args };
}
