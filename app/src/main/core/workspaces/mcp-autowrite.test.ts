import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeWorkspaceMcpConfig } from './mcp-autowrite';

const tmpDirs: string[] = [];
const quietLogger = { warn: () => undefined };

interface TestMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface TestJson {
  project?: string;
  theme?: string;
  mcpServers: Record<string, TestMcpServer>;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function readJson(target: string): TestJson {
  return JSON.parse(fs.readFileSync(target, 'utf8')) as TestJson;
}

function snapshot(root: string, home: string): Record<string, string> {
  const targets = {
    claude: path.join(root, '.mcp.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    gemini: path.join(home, '.gemini', 'settings.json'),
  };
  return Object.fromEntries(
    Object.entries(targets).map(([key, target]) => [key, fs.readFileSync(target, 'utf8')]),
  );
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('writeWorkspaceMcpConfig', () => {
  it('writes all provider configs idempotently', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');

    const first = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger });
    const before = snapshot(root, home);
    const second = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger });
    const after = snapshot(root, home);

    expect(first.refused).toEqual([]);
    expect(second.refused).toEqual([]);
    expect(first.claude).toBe(path.join(root, '.mcp.json'));
    expect(first.codex).toBe(path.join(home, '.codex', 'config.toml'));
    expect(first.gemini).toBe(path.join(home, '.gemini', 'settings.json'));
    expect(after).toEqual(before);

    const claude = readJson(first.claude!);
    expect(claude.mcpServers.ruflo).toEqual({
      command: 'npx',
      args: ['@claude-flow/cli@latest', 'mcp-stdio'],
      env: { CLAUDE_FLOW_DIR: path.join(root, '.claude-flow') },
    });
    expect(before.codex.match(/\[mcp_servers\.ruflo\]/g)).toHaveLength(1);
    expect(before.codex.match(/\[mcp_servers\.ruflo\.env\]/g)).toHaveLength(1);
  });

  it('merges Ruflo entries without clobbering unrelated config', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    const codexPath = path.join(home, '.codex', 'config.toml');
    const geminiPath = path.join(home, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.mkdirSync(path.dirname(geminiPath), { recursive: true });

    fs.writeFileSync(
      claudePath,
      JSON.stringify(
        {
          project: 'keep-me',
          mcpServers: {
            browser: { url: 'http://127.0.0.1:1/mcp' },
            ruflo: { command: 'npx', args: ['old'], env: { KEEP: '1' } },
          },
        },
        null,
        2,
      ) + '\n',
    );
    fs.writeFileSync(
      codexPath,
      [
        '# keep this comment',
        '[mcp_servers.browser]',
        'transport = "http"',
        'url = "http://127.0.0.1:1/mcp"',
        '',
        '[mcp_servers.ruflo]',
        'command = "npx"',
        'args = ["old"]',
        '',
        '[mcp_servers.ruflo.env]',
        'CLAUDE_FLOW_DIR = "/old"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      geminiPath,
      JSON.stringify(
        {
          theme: 'dark',
          mcpServers: {
            browser: { url: 'http://127.0.0.1:1/mcp' },
            ruflo: { command: 'npx', args: ['old'], env: { KEEP: '1' } },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger });
    expect(result.refused).toEqual([]);

    const claude = readJson(claudePath);
    expect(claude.project).toBe('keep-me');
    expect(claude.mcpServers.browser).toEqual({ url: 'http://127.0.0.1:1/mcp' });
    expect(claude.mcpServers.ruflo.env).toEqual({
      KEEP: '1',
      CLAUDE_FLOW_DIR: path.join(root, '.claude-flow'),
    });

    const codex = fs.readFileSync(codexPath, 'utf8');
    expect(codex).toContain('# keep this comment');
    expect(codex).toContain('[mcp_servers.browser]');
    expect(codex).toContain('url = "http://127.0.0.1:1/mcp"');
    expect(codex).toContain(`CLAUDE_FLOW_DIR = ${JSON.stringify(path.join(root, '.claude-flow'))}`);
    expect(codex.match(/\[mcp_servers\.ruflo\]/g)).toHaveLength(1);

    const gemini = readJson(geminiPath);
    expect(gemini.theme).toBe('dark');
    expect(gemini.mcpServers.browser).toEqual({ url: 'http://127.0.0.1:1/mcp' });
    expect(gemini.mcpServers.ruflo.env).toEqual({
      KEEP: '1',
      CLAUDE_FLOW_DIR: path.join(root, '.claude-flow'),
    });
  });

  it('refuses custom Ruflo entries instead of overwriting them', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    const codexPath = path.join(home, '.codex', 'config.toml');
    const geminiPath = path.join(home, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.mkdirSync(path.dirname(geminiPath), { recursive: true });

    fs.writeFileSync(
      claudePath,
      JSON.stringify({ mcpServers: { ruflo: { command: 'uvx', args: ['custom'] } } }, null, 2) +
        '\n',
    );
    fs.writeFileSync(
      codexPath,
      ['[mcp_servers.ruflo]', 'command = "uvx"', 'args = ["custom"]', ''].join('\n'),
    );
    fs.writeFileSync(
      geminiPath,
      JSON.stringify({ mcpServers: { ruflo: { command: 'uvx', args: ['custom'] } } }, null, 2) +
        '\n',
    );
    const before = snapshot(root, home);

    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger });

    expect(result).toEqual({ claude: null, codex: null, gemini: null, refused: result.refused });
    expect(result.refused.sort()).toEqual([claudePath, codexPath, geminiPath].sort());
    expect(snapshot(root, home)).toEqual(before);
  });

  it('does not partially write when any Ruflo entry is custom', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    const codexPath = path.join(home, '.codex', 'config.toml');
    const geminiPath = path.join(home, '.gemini', 'settings.json');
    fs.writeFileSync(
      claudePath,
      JSON.stringify({ mcpServers: { ruflo: { command: 'uvx', args: ['custom'] } } }, null, 2) +
        '\n',
    );

    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger });

    expect(result.claude).toBeNull();
    expect(result.codex).toBeNull();
    expect(result.gemini).toBeNull();
    expect(result.refused).toEqual([claudePath]);
    expect(fs.existsSync(codexPath)).toBe(false);
    expect(fs.existsSync(geminiPath)).toBe(false);
    expect(readJson(claudePath).mcpServers.ruflo).toEqual({
      command: 'uvx',
      args: ['custom'],
    });
  });
});
