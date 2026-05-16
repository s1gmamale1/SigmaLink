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

interface TestOpencodeJson {
  $schema?: string;
  model?: string;
  mcp?: Record<string, {
    type?: string;
    command?: unknown;
    environment?: Record<string, string>;
    enabled?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function readJson(target: string): TestJson {
  return JSON.parse(fs.readFileSync(target, 'utf8')) as TestJson;
}

function readOpencodeJson(target: string): TestOpencodeJson {
  return JSON.parse(fs.readFileSync(target, 'utf8')) as TestOpencodeJson;
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
    // Inject detectCli=false so kimi/opencode are always skipped regardless of the
    // test runner's PATH, making this test environment-independent.
    const detectCli = (): boolean => false;

    const first = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });
    const before = snapshot(root, home);
    const second = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });
    const after = snapshot(root, home);

    expect(first.refused).toEqual([]);
    expect(second.refused).toEqual([]);
    expect(first.claude).toBe(path.join(root, '.mcp.json'));
    expect(first.codex).toBe(path.join(home, '.codex', 'config.toml'));
    expect(first.gemini).toBe(path.join(home, '.gemini', 'settings.json'));
    // kimi/opencode skipped — detectCli returns false, no existing file
    expect(first.kimi).toBeNull();
    expect(first.opencode).toBeNull();
    expect(after).toEqual(before);

    const claude = readJson(first.claude!);
    expect(claude.mcpServers.ruflo).toEqual({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
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
    // Suppress kimi/opencode detection so result is deterministic
    const detectCli = (): boolean => false;

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

    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result).toEqual({
      claude: null,
      codex: null,
      gemini: null,
      kimi: null,
      opencode: null,
      refused: result.refused,
    });
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

  // ─── Step B: 9 new test cases ───────────────────────────────────────────────

  it('writes Kimi mcp.json when kimi binary is detected', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const kimiPath = path.join(home, '.kimi', 'mcp.json');

    const detectCli = (name: 'kimi' | 'opencode') => name === 'kimi';
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.kimi).toBe(kimiPath);
    expect(fs.existsSync(kimiPath)).toBe(true);
    const parsed = readJson(kimiPath);
    expect(parsed.mcpServers.ruflo).toMatchObject({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
    });
    expect((parsed.mcpServers.ruflo as { env?: Record<string, string> }).env?.CLAUDE_FLOW_DIR).toBe(
      path.join(root, '.claude-flow'),
    );
  });

  it('skips Kimi when binary not detected and no existing config', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const kimiPath = path.join(home, '.kimi', 'mcp.json');

    const detectCli = (): boolean => false;
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.kimi).toBeNull();
    expect(fs.existsSync(kimiPath)).toBe(false);
  });

  it('writes Kimi when existing file is present even without binary on PATH', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const kimiPath = path.join(home, '.kimi', 'mcp.json');
    fs.mkdirSync(path.dirname(kimiPath), { recursive: true });
    fs.writeFileSync(kimiPath, JSON.stringify({}) + '\n');

    const detectCli = (): boolean => false;
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.kimi).toBe(kimiPath);
    const parsed = readJson(kimiPath);
    expect(parsed.mcpServers.ruflo).toMatchObject({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
    });
  });

  it('writes OpenCode opencode.json with type:local, array command, environment key', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');

    const detectCli = (name: 'kimi' | 'opencode') => name === 'opencode';
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.opencode).toBe(opencodePath);
    expect(fs.existsSync(opencodePath)).toBe(true);
    const parsed = readOpencodeJson(opencodePath);
    expect(parsed.mcp?.ruflo?.type).toBe('local');
    expect(parsed.mcp?.ruflo?.command).toEqual([
      'npx',
      '-y',
      '@claude-flow/cli@latest',
      'mcp',
      'start',
    ]);
    expect(parsed.mcp?.ruflo?.environment?.CLAUDE_FLOW_DIR).toBe(
      path.join(root, '.claude-flow'),
    );
    expect(parsed.mcp?.ruflo?.enabled).toBe(true);
  });

  it('preserves OpenCode $schema and unrelated top-level keys', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
    fs.writeFileSync(
      opencodePath,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'anthropic/claude-sonnet',
          mcp: {
            browser: { whatever: true },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const detectCli = (name: 'kimi' | 'opencode') => name === 'opencode';
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.opencode).toBe(opencodePath);
    const parsed = readOpencodeJson(opencodePath);
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.model).toBe('anthropic/claude-sonnet');
    expect(parsed.mcp?.browser).toEqual({ whatever: true });
    expect(parsed.mcp?.ruflo?.type).toBe('local');
    expect(parsed.mcp?.ruflo?.command).toEqual([
      'npx',
      '-y',
      '@claude-flow/cli@latest',
      'mcp',
      'start',
    ]);
  });

  it('merges OpenCode entry without clobbering user env vars or enabled=false', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
    fs.writeFileSync(
      opencodePath,
      JSON.stringify(
        {
          mcp: {
            ruflo: {
              type: 'local',
              command: ['npx', 'old'],
              environment: { KEEP: '1' },
              enabled: false,
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const detectCli = (name: 'kimi' | 'opencode') => name === 'opencode';
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.opencode).toBe(opencodePath);
    const parsed = readOpencodeJson(opencodePath);
    // enabled:false must survive
    expect(parsed.mcp?.ruflo?.enabled).toBe(false);
    // KEEP env var must be retained
    expect(parsed.mcp?.ruflo?.environment?.KEEP).toBe('1');
    // command updated to canonical
    expect(parsed.mcp?.ruflo?.command).toEqual([
      'npx',
      '-y',
      '@claude-flow/cli@latest',
      'mcp',
      'start',
    ]);
    // CLAUDE_FLOW_DIR updated
    expect(parsed.mcp?.ruflo?.environment?.CLAUDE_FLOW_DIR).toBe(
      path.join(root, '.claude-flow'),
    );
  });

  it('refuses OpenCode when command[0] is not npx', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
    const originalContent =
      JSON.stringify(
        {
          mcp: {
            ruflo: { type: 'local', command: ['bunx', 'custom'] },
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(opencodePath, originalContent);

    const detectCli = (name: 'kimi' | 'opencode') => name === 'opencode';
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.opencode).toBeNull();
    expect(result.refused).toContain(opencodePath);
    // file must be unchanged
    expect(fs.readFileSync(opencodePath, 'utf8')).toBe(originalContent);
  });

  it('refuses Kimi when existing ruflo entry is user-managed', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const kimiPath = path.join(home, '.kimi', 'mcp.json');
    fs.mkdirSync(path.dirname(kimiPath), { recursive: true });
    const originalContent =
      JSON.stringify(
        {
          mcpServers: {
            ruflo: { command: 'uvx', args: ['custom'] },
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(kimiPath, originalContent);

    const detectCli = (name: 'kimi' | 'opencode') => name === 'kimi';
    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    expect(result.kimi).toBeNull();
    expect(result.refused).toContain(kimiPath);
    expect(fs.readFileSync(kimiPath, 'utf8')).toBe(originalContent);
  });

  it("canonical args use 'mcp start' not 'mcp-stdio' (regression pin v1.3.4 bug fix)", () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const detectCli = (name: 'kimi' | 'opencode') => name === 'kimi';

    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    const claudeParsed = readJson(result.claude!);
    expect(claudeParsed.mcpServers.ruflo.args).toEqual([
      '-y',
      '@claude-flow/cli@latest',
      'mcp',
      'start',
    ]);
    expect(claudeParsed.mcpServers.ruflo.args).not.toContain('mcp-stdio');

    const kimiParsed = readJson(result.kimi!);
    expect(kimiParsed.mcpServers.ruflo.args).toEqual([
      '-y',
      '@claude-flow/cli@latest',
      'mcp',
      'start',
    ]);
    expect(kimiParsed.mcpServers.ruflo.args).not.toContain('mcp-stdio');
  });
});
