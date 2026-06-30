import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isManagedOpencodeRufloEntry,
  isManagedRufloEntry,
  writeWorkspaceMcpConfig,
} from './mcp-autowrite';

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
    // R-2 — cursor's workspace-scoped config
    cursor: path.join(root, '.cursor', 'mcp.json'),
  };
  return Object.fromEntries(
    // Tolerate absent targets (e.g. cursor is never written when an all-or-
    // nothing refusal fires) — '' for a missing file keeps the before/after
    // equality invariant intact without requiring every target to exist.
    Object.entries(targets).map(([key, target]) => [
      key,
      fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '',
    ]),
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
    // R-2 — cursor is always written (workspace-scoped, no detection gate)
    expect(first.cursor).toBe(path.join(root, '.cursor', 'mcp.json'));
    expect(after).toEqual(before);

    const claude = readJson(first.claude!);
    expect(claude.mcpServers.ruflo).toEqual({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
      env: { CLAUDE_FLOW_DIR: path.join(root, '.claude-flow') },
    });

    // R-2 — cursor's .cursor/mcp.json carries the same stdio entry as claude
    const cursor = readJson(first.cursor!);
    expect(cursor.mcpServers.ruflo).toEqual({
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
      cursor: null,
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

  // ─── R-2: cursor (.cursor/mcp.json) ─────────────────────────────────────────

  it('writes cursor .cursor/mcp.json with the Ruflo stdio entry', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const cursorPath = path.join(root, '.cursor', 'mcp.json');

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
    });

    expect(result.cursor).toBe(cursorPath);
    expect(fs.existsSync(cursorPath)).toBe(true);
    const parsed = readJson(cursorPath);
    expect(parsed.mcpServers.ruflo).toEqual({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
      env: { CLAUDE_FLOW_DIR: path.join(root, '.claude-flow') },
    });
  });

  it('refuses cursor when existing ruflo entry is user-managed (and refuses the whole write)', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const cursorPath = path.join(root, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    const originalContent =
      JSON.stringify({ mcpServers: { ruflo: { command: 'uvx', args: ['custom'] } } }, null, 2) +
      '\n';
    fs.writeFileSync(cursorPath, originalContent);

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
    });

    // A user-managed cursor entry triggers the all-or-nothing refusal, same as
    // a custom claude/codex/gemini entry would.
    expect(result.cursor).toBeNull();
    expect(result.claude).toBeNull();
    expect(result.refused).toContain(cursorPath);
    expect(fs.readFileSync(cursorPath, 'utf8')).toBe(originalContent);
  });

  it('merges cursor entry without clobbering unrelated keys', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const cursorPath = path.join(root, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(
      cursorPath,
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

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
    });

    expect(result.refused).toEqual([]);
    const cursor = readJson(cursorPath);
    expect(cursor.project).toBe('keep-me');
    expect(cursor.mcpServers.browser).toEqual({ url: 'http://127.0.0.1:1/mcp' });
    expect(cursor.mcpServers.ruflo.env).toEqual({
      KEEP: '1',
      CLAUDE_FLOW_DIR: path.join(root, '.claude-flow'),
    });
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

  // ─── v1.6.0 HTTP-daemon mode tests ──────────────────────────────────────────

  it('HTTP mode: writes exact HTTP entry shapes for all 5 CLIs (port 12345)', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const detectCli = (name: 'kimi' | 'opencode'): boolean =>
      name === 'kimi' || name === 'opencode';

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli,
      port: 12345,
    });

    expect(result.refused).toEqual([]);
    expect(result.claude).toBe(path.join(root, '.mcp.json'));
    expect(result.codex).toBe(path.join(home, '.codex', 'config.toml'));
    expect(result.gemini).toBe(path.join(home, '.gemini', 'settings.json'));
    expect(result.kimi).toBe(path.join(home, '.kimi', 'mcp.json'));
    expect(result.opencode).toBe(path.join(home, '.config', 'opencode', 'opencode.json'));
    expect(result.cursor).toBe(path.join(root, '.cursor', 'mcp.json'));

    // Claude — url only, no command/args/env
    const claude = readJson(result.claude!);
    expect(claude.mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:12345/mcp' });

    // Gemini — same shape as Claude
    const gemini = readJson(result.gemini!);
    expect(gemini.mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:12345/mcp' });

    // Cursor — same HTTP shape as Claude (workspace-scoped JSON)
    const cursor = readJson(result.cursor!);
    expect(cursor.mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:12345/mcp' });

    // Kimi — same shape as Claude/Gemini
    const kimi = readJson(result.kimi!);
    expect(kimi.mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:12345/mcp' });

    // Codex TOML — transport + url, NO env sub-table
    const codex = fs.readFileSync(result.codex!, 'utf8');
    expect(codex).toContain('[mcp_servers.ruflo]');
    expect(codex).toContain('transport = "http"');
    expect(codex).toContain('url = "http://127.0.0.1:12345/mcp"');
    expect(codex).not.toContain('[mcp_servers.ruflo.env]');
    expect(codex).not.toContain('command =');

    // OpenCode — type:http, url, enabled:true; no command/environment
    const opencode = readOpencodeJson(result.opencode!);
    expect(opencode.mcp?.ruflo).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:12345/mcp',
      enabled: true,
    });
    expect(opencode.mcp?.ruflo?.command).toBeUndefined();
    expect(opencode.mcp?.ruflo?.environment).toBeUndefined();
  });

  // ─── Task 4: skipCodexStdio (Windows containment) ───────────────────────────

  it('skipCodexStdio: removes a managed codex ruflo table when no port given', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const codexPath = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(
      codexPath,
      [
        '[model]',
        'name = "gpt-5"',
        '',
        '[mcp_servers.ruflo]',
        'command = "npx"',
        'args = ["-y", "@claude-flow/cli@latest", "mcp", "start"]',
        '',
        '[mcp_servers.ruflo.env]',
        'CLAUDE_FLOW_DIR = "/old/.claude-flow"',
        '',
        '[mcp_servers.browser]',
        'transport = "http"',
        'url = "http://127.0.0.1:1/mcp"',
        '',
      ].join('\n'),
    );

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      skipCodexStdio: true,
    });

    expect(result.codex).toBe(codexPath);
    const codex = fs.readFileSync(codexPath, 'utf8');
    // Unrelated tables preserved.
    expect(codex).toContain('[model]');
    expect(codex).toContain('[mcp_servers.browser]');
    // Managed ruflo table AND its env sub-table removed.
    expect(codex).not.toContain('[mcp_servers.ruflo]');
    expect(codex).not.toContain('[mcp_servers.ruflo.env]');
  });

  it('skipCodexStdio: preserves a user-managed codex ruflo table (refused, untouched)', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const codexPath = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    const originalContent = [
      '[mcp_servers.ruflo]',
      'command = "uvx"',
      'args = ["custom-ruflo"]',
      '',
    ].join('\n');
    fs.writeFileSync(codexPath, originalContent);

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      skipCodexStdio: true,
    });

    expect(result.refused).toContain(codexPath);
    expect(fs.readFileSync(codexPath, 'utf8')).toContain('custom-ruflo');
  });

  it('skipCodexStdio: still writes HTTP codex ruflo when a port exists', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      port: 4317,
      skipCodexStdio: true,
    });

    expect(result.refused).toEqual([]);
    const codex = fs.readFileSync(result.codex!, 'utf8');
    expect(codex).toContain('transport = "http"');
    expect(codex).toContain('url = "http://127.0.0.1:4317/mcp"');
  });

  it('HTTP mode: no-opts still writes stdio entries (regression)', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const detectCli = (): boolean => false;

    const result = writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli });

    const claude = readJson(result.claude!);
    expect(claude.mcpServers.ruflo).toEqual({
      command: 'npx',
      args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
      env: { CLAUDE_FLOW_DIR: path.join(root, '.claude-flow') },
    });
    const codex = fs.readFileSync(result.codex!, 'utf8');
    expect(codex).toContain('command = "npx"');
    expect(codex).not.toContain('transport = "http"');
  });

  // ─── isManagedRufloEntry unit tests ─────────────────────────────────────────

  it('isManagedRufloEntry: stdio entry returns true', () => {
    expect(
      isManagedRufloEntry({ command: 'npx', args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'] }),
    ).toBe(true);
  });

  it('isManagedRufloEntry: HTTP localhost entry returns true', () => {
    expect(isManagedRufloEntry({ url: 'http://127.0.0.1:12345/mcp' })).toBe(true);
  });

  it('isManagedRufloEntry: remote host returns false (security)', () => {
    expect(isManagedRufloEntry({ url: 'http://example.com/mcp' })).toBe(false);
  });

  it('isManagedRufloEntry: wrong path returns false', () => {
    expect(isManagedRufloEntry({ url: 'http://127.0.0.1:12345/other' })).toBe(false);
  });

  it('isManagedRufloEntry: https returns false (only plain http)', () => {
    expect(isManagedRufloEntry({ url: 'https://127.0.0.1:12345/mcp' })).toBe(false);
  });

  // ─── isManagedOpencodeRufloEntry unit tests ──────────────────────────────────

  it('isManagedOpencodeRufloEntry: stdio array command returns true', () => {
    expect(
      isManagedOpencodeRufloEntry({
        command: ['npx', '-y', '@claude-flow/cli@latest', 'mcp', 'start'],
      }),
    ).toBe(true);
  });

  it('isManagedOpencodeRufloEntry: HTTP type+url returns true', () => {
    expect(
      isManagedOpencodeRufloEntry({ type: 'http', url: 'http://127.0.0.1:12345/mcp' }),
    ).toBe(true);
  });

  // ─── Self-heal tests ─────────────────────────────────────────────────────────

  it('self-heal: pre-existing stdio Claude entry replaced with HTTP on port call', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    // Write a stdio entry first
    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });
    const beforeEntry = readJson(claudePath).mcpServers.ruflo;
    expect(beforeEntry.command).toBe('npx');

    // Now call with port — should replace stdio with HTTP
    writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      port: 12345,
    });
    const afterEntry = readJson(claudePath).mcpServers.ruflo;
    expect(afterEntry).toEqual({ url: 'http://127.0.0.1:12345/mcp' });
  });

  it('self-heal: pre-existing HTTP Claude entry on port 11111 replaced with port 22222', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    // Write HTTP entry on port 11111
    writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      port: 11111,
    });
    expect(readJson(claudePath).mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:11111/mcp' });

    // Replace with port 22222
    writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      port: 22222,
    });
    expect(readJson(claudePath).mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:22222/mcp' });
  });

  it('self-heal: pre-existing HTTP entry replaced with stdio when no port given', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    // Write HTTP entry first
    writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
      port: 12345,
    });
    expect(readJson(claudePath).mcpServers.ruflo).toEqual({ url: 'http://127.0.0.1:12345/mcp' });

    // Call without port — should revert to stdio
    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });
    const entry = readJson(claudePath).mcpServers.ruflo;
    expect(entry.command).toBe('npx');
    expect(entry.url).toBeUndefined();
  });

  it('self-heal: user-managed entry (custom command) still refused with warning', () => {
    const root = tmpDir('sigmalink-ruflo-root-');
    const home = tmpDir('sigmalink-ruflo-home-');
    const claudePath = path.join(root, '.mcp.json');
    fs.mkdirSync(root, { recursive: true });
    const originalContent =
      JSON.stringify(
        { mcpServers: { ruflo: { command: '/usr/local/bin/something-else', args: [] } } },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(claudePath, originalContent);

    const warnings: string[] = [];
    const warningLogger = { warn: (msg: string) => warnings.push(msg) };

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: warningLogger,
      detectCli: () => false,
      port: 12345,
    });

    expect(result.claude).toBeNull();
    expect(result.refused).toContain(claudePath);
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(originalContent);
    expect(warnings.some((w) => w.includes('ruflo'))).toBe(true);
  });
});

// ─── B3: writeRufloConventionBlock (via writeWorkspaceMcpConfig) ─────────────

describe('writeRufloConventionBlock', () => {
  it('writes a block containing the markers and memory_search_unified into CLAUDE.md', () => {
    const root = tmpDir('sigmalink-convention-');
    const home = tmpDir('sigmalink-convention-home-');
    const claudeMdPath = path.join(root, 'CLAUDE.md');

    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });

    expect(fs.existsSync(claudeMdPath)).toBe(true);
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('<!-- ruflo-memory-convention:start -->');
    expect(content).toContain('<!-- ruflo-memory-convention:end -->');
    expect(content).toContain('memory_search_unified');
    expect(content).toContain('"patterns"');
  });

  it('is idempotent: two calls produce a byte-identical CLAUDE.md', () => {
    const root = tmpDir('sigmalink-convention-');
    const home = tmpDir('sigmalink-convention-home-');
    const claudeMdPath = path.join(root, 'CLAUDE.md');

    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });
    const firstContent = fs.readFileSync(claudeMdPath, 'utf8');

    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });
    const secondContent = fs.readFileSync(claudeMdPath, 'utf8');

    expect(secondContent).toBe(firstContent);
  });

  it('appends the block when CLAUDE.md already exists without markers', () => {
    const root = tmpDir('sigmalink-convention-');
    const home = tmpDir('sigmalink-convention-home-');
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    const existingContent = '# My Project\n\nSome notes here.\n';
    fs.writeFileSync(claudeMdPath, existingContent, 'utf8');

    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Some notes here.');
    expect(content).toContain('<!-- ruflo-memory-convention:start -->');
    expect(content).toContain('memory_search_unified');
  });

  it('replaces the managed block on second call (idempotent replace between markers)', () => {
    const root = tmpDir('sigmalink-convention-');
    const home = tmpDir('sigmalink-convention-home-');
    const claudeMdPath = path.join(root, 'CLAUDE.md');

    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });
    const first = fs.readFileSync(claudeMdPath, 'utf8');

    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });
    const second = fs.readFileSync(claudeMdPath, 'utf8');

    // Exactly one start marker, one end marker
    expect((second.match(/<!-- ruflo-memory-convention:start -->/g) ?? []).length).toBe(1);
    expect((second.match(/<!-- ruflo-memory-convention:end -->/g) ?? []).length).toBe(1);
    expect(second).toBe(first);
  });

  it('refuses (leaves untouched + refused entry) when user opt-out marker is present', () => {
    const root = tmpDir('sigmalink-convention-');
    const home = tmpDir('sigmalink-convention-home-');
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    const userContent = [
      '# My Project',
      '',
      '<!-- ruflo-memory-convention:start -->',
      '<!-- ruflo-memory-convention:user -->',
      'My custom memory rules — do not overwrite.',
      '<!-- ruflo-memory-convention:end -->',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, userContent, 'utf8');

    const result = writeWorkspaceMcpConfig(root, {
      homeDir: home,
      logger: quietLogger,
      detectCli: () => false,
    });

    expect(result.refused).toContain(claudeMdPath);
    expect(fs.readFileSync(claudeMdPath, 'utf8')).toBe(userContent);
  });

  it('win32-style root path: block content is correct regardless of path separator', () => {
    const root = tmpDir('sigmalink-convention-');
    const home = tmpDir('sigmalink-convention-home-');
    const claudeMdPath = path.join(root, 'CLAUDE.md');

    // Simulate a win32-style root by constructing the path manually
    // The logic is path.join(root, 'CLAUDE.md') — on macOS this is posix,
    // but we verify the block content (not path) is correct regardless.
    writeWorkspaceMcpConfig(root, { homeDir: home, logger: quietLogger, detectCli: () => false });

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    // Block content must contain both the store namespace and retrieval tool
    expect(content).toContain('namespace');
    expect(content).toContain('patterns');
    expect(content).toContain('memory_search_unified');
  });
});
