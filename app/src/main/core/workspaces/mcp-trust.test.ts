import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRufloTrusted, defaultRunCli } from './mcp-trust';

const trustSpawnCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[]) => {
    trustSpawnCalls.push({ cmd, args });
    return {
      kill: () => {},
      once: (event: string, cb: () => void) => {
        if (event === 'exit') queueMicrotask(cb);
      },
      unref: () => {},
    };
  },
}));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf7-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const settingsPath = (r: string) => path.join(r, '.claude', 'settings.local.json');
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('ensureRufloTrusted — claude', () => {
  it('writes enabledMcpjsonServers:["ruflo"] when no settings file exists', () => {
    const res = ensureRufloTrusted(root, {
      homeDir: root,
      runCli: () => {},
      detectCli: () => false,
    });
    expect(res.claude).toBe('written');
    expect(read(settingsPath(root)).enabledMcpjsonServers).toEqual(['ruflo']);
  });

  it('is idempotent — second call reports "already", array unchanged', () => {
    ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('already');
    expect(read(settingsPath(root)).enabledMcpjsonServers).toEqual(['ruflo']);
  });

  it('merges additively — preserves existing servers + other keys', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsPath(root),
      JSON.stringify({ enabledMcpjsonServers: ['other'], theme: 'dark' }),
    );
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('written');
    const s = read(settingsPath(root));
    expect(s.enabledMcpjsonServers.sort()).toEqual(['other', 'ruflo']);
    expect(s.theme).toBe('dark');
  });

  it('fail-open — unparseable settings file is left untouched, reports "skipped"', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(root), '{ not valid json');
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('skipped');
    expect(fs.readFileSync(settingsPath(root), 'utf8')).toBe('{ not valid json');
  });

  it('fail-open — JSON array (non-object) settings file is left untouched, reports "skipped"', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(root), JSON.stringify(['not', 'an', 'object']));
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('skipped');
    expect(read(settingsPath(root))).toEqual(['not', 'an', 'object']);
  });

  it('never enables wildcard / all-servers flags — only the ruflo name', () => {
    ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    const s = read(settingsPath(root));
    expect(s.enabledMcpjsonServers).toEqual(['ruflo']);
    expect(s.enableAllProjectMcpServers).toBeUndefined();
    expect(Object.keys(s)).not.toContain('enableAllProjectMcpServers');
  });
});

describe('ensureRufloTrusted — cursor + no-ops', () => {
  it('cursor: runs `cursor-agent mcp enable ruflo` when detected', () => {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const res = ensureRufloTrusted(root, {
      homeDir: root,
      detectCli: (n) => n === 'cursor-agent',
      runCli: (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    });
    expect(res.cursor).toBe('written');
    expect(calls).toEqual([{ cmd: 'cursor-agent', args: ['mcp', 'enable', 'ruflo'], cwd: root }]);
  });

  it('cursor: no-op when cursor-agent not on PATH', () => {
    const res = ensureRufloTrusted(root, {
      homeDir: root,
      detectCli: () => false,
      runCli: () => {
        throw new Error('should not run');
      },
    });
    expect(res.cursor).toBe('noop');
  });

  it('cursor: default runner is disabled in unit tests unless a seam is injected', () => {
    const res = ensureRufloTrusted(root, { homeDir: root });
    expect(res.cursor).toBe('noop');
  });

  it('cursor: fail-open when enable throws', () => {
    const res = ensureRufloTrusted(root, {
      homeDir: root,
      detectCli: (n) => n === 'cursor-agent',
      runCli: () => {
        throw new Error('boom');
      },
    });
    expect(res.cursor).toBe('error'); // never throws
  });

  it('codex/gemini/kimi/opencode are documented no-ops', () => {
    const res = ensureRufloTrusted(root, { homeDir: root, detectCli: () => false, runCli: () => {} });
    expect([res.codex, res.gemini, res.kimi, res.opencode]).toEqual([
      'noop',
      'noop',
      'noop',
      'noop',
    ]);
  });
});

describe('defaultRunCli', () => {
  it('spawns cursor-agent via spawnExecutable so detect (.cmd-aware) and run agree', () => {
    trustSpawnCalls.length = 0;
    defaultRunCli('cursor-agent', ['mcp', 'enable', 'ruflo'], '/tmp');
    expect(trustSpawnCalls).toEqual([
      { cmd: 'cursor-agent', args: ['mcp', 'enable', 'ruflo'] },
    ]);
  });
});
