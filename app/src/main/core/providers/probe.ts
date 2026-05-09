// PATH probe + version detection for installed CLI agents.
//
// On Windows, `where` returns the resolved file path (including the .cmd
// extension). We forward that path to the version probe so child_process's
// argument-array spawn (which does NOT honour PATHEXT) can find the binary.

import path from 'node:path';
import { execCmd } from '../../lib/exec';
import { AGENT_PROVIDERS, type AgentProviderDefinition } from '../../../shared/providers';
import type { ProviderProbe } from '../../../shared/types';

const VERSION_RE = /(\d+\.\d+(?:\.\d+)*(?:[\w.+-]*)?)/;

async function whichLike(cmd: string): Promise<string | undefined> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = await execCmd(which, [cmd], { timeoutMs: 5_000 });
    if (res.code !== 0) return undefined;
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}

async function execVersion(
  resolved: string,
  versionArgs: string[],
): Promise<{ stdout: string; stderr: string }> {
  // On Windows, the resolved path may be a .cmd shim; argv-array spawn cannot
  // execute it directly, so we route through cmd.exe. .ps1 routes through
  // powershell.exe. .exe is run directly so we don't pay an extra process.
  if (process.platform === 'win32') {
    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      const r = await execCmd('cmd.exe', ['/d', '/s', '/c', resolved, ...versionArgs], {
        timeoutMs: 8_000,
      });
      return { stdout: r.stdout, stderr: r.stderr };
    }
    if (ext === '.ps1') {
      const r = await execCmd(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...versionArgs],
        { timeoutMs: 8_000 },
      );
      return { stdout: r.stdout, stderr: r.stderr };
    }
  }
  const r = await execCmd(resolved, versionArgs, { timeoutMs: 8_000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

export async function probeProvider(p: AgentProviderDefinition): Promise<ProviderProbe> {
  const candidates = [p.command, ...(p.altCommands ?? [])].filter(Boolean) as string[];
  for (const cmd of candidates) {
    const resolved = await whichLike(cmd);
    if (!resolved) continue;
    let version: string | undefined;
    try {
      const versionArgs = p.versionArgs ?? ['--version'];
      const v = await execVersion(resolved, versionArgs);
      const haystack = (v.stdout || v.stderr).toString();
      const match = haystack.match(VERSION_RE);
      if (match) version = match[1];
    } catch {
      /* probe is best-effort */
    }
    return { id: p.id, found: true, resolvedPath: resolved, version };
  }
  return { id: p.id, found: false };
}

export async function probeAllProviders(): Promise<ProviderProbe[]> {
  return Promise.all(AGENT_PROVIDERS.filter((p) => p.detectable !== false && p.command).map(probeProvider));
}

export async function probeProviderById(id: string): Promise<ProviderProbe> {
  const p = AGENT_PROVIDERS.find((x) => x.id === id);
  if (!p) return { id, found: false, error: 'unknown provider' };
  return probeProvider(p);
}
