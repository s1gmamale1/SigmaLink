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

// cmd.exe metacharacters that need caret-escaping when a token sits OUTSIDE
// double quotes. This is cross-spawn's battle-tested set (the npm ecosystem
// runs on it): parens, brackets, percent, bang, caret, quote, backtick,
// angle brackets, ampersand, pipe, semicolon, comma, SPACE, star, question.
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape the resolved command path for the inner line of
 * `cmd.exe /d /s /c "<inner>"`.
 *
 * The path is NOT quoted; every cmd metachar — including spaces — is
 * caret-escaped (`C:\Users\First^ Last\npm\claude.cmd`). `^X` outside quotes
 * makes X literal without splitting the command token. A quoted form cannot
 * work here: carets inside quotes are LITERAL, so a quoted path could never
 * protect `%` (phase-1 expansion ignores quotes) — see cmdEscapeArg.
 */
export function cmdEscapeCommandPath(resolvedPath: string): string {
  return resolvedPath.replace(CMD_META_RE, '^$1');
}

/**
 * Escape ONE argument for the inner line of `cmd.exe /d /s /c "<inner>"`.
 * cross-spawn's algorithm, derived from https://qntm.org/cmd:
 *
 *  1. Win32-argv (MSVCRT) layer — what the TARGET re-parses: double every
 *     backslash run before a `"` and emit `\"`; double a trailing backslash
 *     run; wrap in `"…"`.
 *  2. cmd.exe phase-2 layer — caret-escape EVERY metachar INCLUDING the
 *     quotes from layer 1. cmd then never enters in-quotes state: `^&`/`^|`
 *     can't act as operators, and `^%` interleaves carets into would-be
 *     `%VAR%` names (phase 1 looks up the literal name `VAR^`, finds
 *     nothing, leaves the text; phase 2 strips the carets). One cmd parse
 *     collapses the token back to its plain layer-1 form.
 *
 * `doubleEscape` adds a second layer-2 pass: npm `.cmd` shims re-expand `%*`
 * into a fresh `node "%~dp0…cli.js" %*` line — a SECOND full cmd parse.
 * Without it, an arg with an odd embedded quote re-parses with `&` OUTSIDE
 * quotes → live command separator (injection).
 *
 * cmd lines are single-line; a raw newline TERMINATES the line and the rest
 * would execute as a separate command. No escape exists — newlines are
 * replaced with one space (lossy, injection-proof).
 */
export function cmdEscapeArg(arg: string, doubleEscape = false): string {
  let s = String(arg).replace(/[\r\n]+/g, ' ');
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META_RE, '^$1');
  if (doubleEscape) s = s.replace(CMD_META_RE, '^$1');
  return s;
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
   * The `cmd.exe` branch below caret-escapes every token (command path via
   * `cmdEscapeCommandPath`, args via `cmdEscapeArg`) and then wraps the whole
   * inner line in an OUTER pair of quotes that `cmd /d /s /c`
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
    // Command path caret-escaped (never quoted); args double-escaped because
    // every .cmd this app launches is an npm shim that re-expands %* (a
    // second cmd parse). The whole inner line is wrapped in ONE outer pair of
    // quotes that `cmd /d /s /c` strips via /s. The result MUST reach the
    // spawn layer without re-quoting — see `windowsVerbatimArguments`.
    const inner = [
      cmdEscapeCommandPath(resolved),
      ...args.map((a) => cmdEscapeArg(a, true)),
    ].join(' ');
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
