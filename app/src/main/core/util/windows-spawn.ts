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

export function buildWindowsSpawnArgs(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const resolved = resolveWindowsCommand(cmd, env) ?? cmd;
  const kind = windowsExtensionKind(resolved);

  if (kind === 'cmd') {
    const commandLine = [resolved, ...args].map(cmdQuoteArg).join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
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
