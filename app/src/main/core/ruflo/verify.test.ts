import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyForWorkspace, type ProbeRunner } from './verify';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeGoodConfigs(root: string, home: string): void {
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { ruflo: { command: 'npx' } } }, null, 2),
  );
  const codexPath = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(
    codexPath,
    ['[mcp_servers.ruflo]', 'command = "npx"', 'args = ["@claude-flow/cli@latest"]', ''].join('\n'),
  );
  const geminiPath = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
  fs.writeFileSync(
    geminiPath,
    JSON.stringify({ mcpServers: { ruflo: { command: 'npx' } } }, null, 2),
  );
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('verifyForWorkspace', () => {
  it('fast mode verifies Ruflo config entries for all CLIs', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);

    const result = await verifyForWorkspace(root, 'fast', { homeDir: home });

    expect(result).toMatchObject({
      claude: true,
      codex: true,
      gemini: true,
      mode: 'fast',
      errors: [],
    });
  });

  it('fast mode reports missing or non-npx Ruflo entries per CLI', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { ruflo: { command: 'uvx' } } }, null, 2),
    );
    const codexPath = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(codexPath, '[mcp_servers.browser]\ncommand = "npx"\n');

    const result = await verifyForWorkspace(root, 'fast', { homeDir: home });

    expect(result.claude).toBe(false);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(false);
    expect(result.errors.map((e) => e.cli).sort()).toEqual(['claude', 'codex', 'gemini']);
  });

  it('strict mode combines fast config checks with mock CLI probes', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    const calls: string[] = [];
    const probeRunner: ProbeRunner = async (command, args) => {
      calls.push([command, ...args].join(' '));
      return { code: 0, stdout: `${command}: ruflo configured`, stderr: '' };
    };

    const result = await verifyForWorkspace(root, 'strict', { homeDir: home, probeRunner });

    expect(result.claude).toBe(true);
    expect(result.codex).toBe(true);
    expect(result.gemini).toBe(true);
    expect(result.mode).toBe('strict');
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([
      `claude mcp list --workspace ${root}`,
      'codex mcp list',
      'gemini mcp list',
    ]);
  });

  it('strict mode reports individual probe failures', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    const probeRunner: ProbeRunner = async (command) => {
      if (command === 'codex') return { code: 1, stdout: 'browser', stderr: 'missing' };
      return { code: 0, stdout: 'ruflo', stderr: '' };
    };

    const result = await verifyForWorkspace(root, 'strict', { homeDir: home, probeRunner });

    expect(result.claude).toBe(true);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(true);
    expect(result.errors).toEqual([
      { cli: 'codex', message: 'codex mcp list exited 1 without ruflo' },
    ]);
  });
});
