// PATH probe + version detection for installed CLI agents.

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

export async function probeProvider(p: AgentProviderDefinition): Promise<ProviderProbe> {
  const candidates = [p.command, ...(p.altCommands ?? [])].filter(Boolean) as string[];
  for (const cmd of candidates) {
    const resolved = await whichLike(cmd);
    if (!resolved) continue;
    let version: string | undefined;
    try {
      const versionArgs = p.versionArgs ?? ['--version'];
      const v = await execCmd(cmd, versionArgs, { timeoutMs: 8_000 });
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
