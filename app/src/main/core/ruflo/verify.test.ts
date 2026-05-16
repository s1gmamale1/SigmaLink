import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyForWorkspace, type ProbeRunner } from './verify';

const tmpDirs: string[] = [];

// Suppress kimi/opencode PATH detection in all tests that don't explicitly want it,
// so the test suite is hermetic regardless of what's installed on the CI/dev machine.
const noDetect = (): boolean => false;
const detectKimiOnly = (name: 'kimi' | 'opencode') => name === 'kimi';
const detectOpencodeOnly = (name: 'kimi' | 'opencode') => name === 'opencode';
const detectBoth = (): boolean => true;

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

function writeGoodKimiConfig(home: string): string {
  const kimiPath = path.join(home, '.kimi', 'mcp.json');
  fs.mkdirSync(path.dirname(kimiPath), { recursive: true });
  fs.writeFileSync(
    kimiPath,
    JSON.stringify({ mcpServers: { ruflo: { command: 'npx' } } }, null, 2),
  );
  return kimiPath;
}

function writeGoodOpencodeConfig(home: string): string {
  const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  fs.writeFileSync(
    opencodePath,
    JSON.stringify(
      {
        mcp: {
          ruflo: {
            type: 'local',
            command: ['npx', '-y', '@claude-flow/cli@latest', 'mcp', 'start'],
            environment: { CLAUDE_FLOW_DIR: '/some/.claude-flow' },
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
  );
  return opencodePath;
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

    const result = await verifyForWorkspace(root, 'fast', { homeDir: home, detectCli: noDetect });

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

    const result = await verifyForWorkspace(root, 'fast', { homeDir: home, detectCli: noDetect });

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

    const result = await verifyForWorkspace(root, 'strict', {
      homeDir: home,
      probeRunner,
      detectCli: noDetect,
    });

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

    const result = await verifyForWorkspace(root, 'strict', {
      homeDir: home,
      probeRunner,
      detectCli: noDetect,
    });

    expect(result.claude).toBe(true);
    expect(result.codex).toBe(false);
    expect(result.gemini).toBe(true);
    expect(result.errors).toEqual([
      { cli: 'codex', message: 'codex mcp list exited 1 without ruflo' },
    ]);
  });

  // ─── 7 new test cases ──────────────────────────────────────────────────────

  it('fast mode verifies all 5 CLIs when configured', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    writeGoodKimiConfig(home);
    writeGoodOpencodeConfig(home);

    const result = await verifyForWorkspace(root, 'fast', { homeDir: home, detectCli: detectBoth });

    expect(result.claude).toBe(true);
    expect(result.codex).toBe(true);
    expect(result.gemini).toBe(true);
    expect(result.kimi).toBe(true);
    expect(result.opencode).toBe(true);
    expect(result.detected).toEqual({ kimi: true, opencode: true });
    expect(result.errors).toEqual([]);
  });

  it('fast mode treats missing Kimi config as OK when binary not detected', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    // No kimi config written, detectCli returns false for kimi

    const result = await verifyForWorkspace(root, 'fast', { homeDir: home, detectCli: noDetect });

    expect(result.kimi).toBe(true); // vacuously OK — not installed
    expect(result.detected.kimi).toBe(false);
    // No kimi error pushed
    expect(result.errors.some((e) => e.cli === 'kimi')).toBe(false);
  });

  it('fast mode flags missing Kimi config when binary IS detected', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    // Kimi binary detected but no config file written

    const result = await verifyForWorkspace(root, 'fast', {
      homeDir: home,
      detectCli: detectKimiOnly,
    });

    expect(result.kimi).toBe(false);
    expect(result.detected.kimi).toBe(true);
    expect(result.errors.some((e) => e.cli === 'kimi')).toBe(true);
  });

  it('fast mode verifies OpenCode array-command format', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    writeGoodOpencodeConfig(home);

    const result = await verifyForWorkspace(root, 'fast', {
      homeDir: home,
      detectCli: detectOpencodeOnly,
    });

    expect(result.opencode).toBe(true);
    expect(result.errors.some((e) => e.cli === 'opencode')).toBe(false);
  });

  it('fast mode rejects OpenCode with non-npx command[0]', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    const opencodePath = path.join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
    fs.writeFileSync(
      opencodePath,
      JSON.stringify(
        {
          mcp: {
            ruflo: { type: 'local', command: ['bunx', '-y', '@claude-flow/cli@latest'] },
          },
        },
        null,
        2,
      ),
    );

    const result = await verifyForWorkspace(root, 'fast', {
      homeDir: home,
      detectCli: detectOpencodeOnly,
    });

    expect(result.opencode).toBe(false);
    expect(result.errors.some((e) => e.cli === 'opencode')).toBe(true);
    const opencodeError = result.errors.find((e) => e.cli === 'opencode');
    expect(opencodeError?.message).toContain('bunx');
  });

  it('strict mode probes kimi mcp list and opencode mcp list when detected', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);
    writeGoodKimiConfig(home);
    writeGoodOpencodeConfig(home);

    const calls: string[] = [];
    const probeRunner: ProbeRunner = async (command, args) => {
      calls.push([command, ...args].join(' '));
      return { code: 0, stdout: 'ruflo is configured', stderr: '' };
    };

    const result = await verifyForWorkspace(root, 'strict', {
      homeDir: home,
      probeRunner,
      detectCli: detectBoth,
    });

    expect(result.kimi).toBe(true);
    expect(result.opencode).toBe(true);
    // Verify probe args use 'mcp list'
    expect(calls).toContain('kimi mcp list');
    expect(calls).toContain('opencode mcp list');
    expect(result.errors.some((e) => e.cli === 'kimi' || e.cli === 'opencode')).toBe(false);
  });

  it('strict mode skips probe for undetected CLIs', async () => {
    const root = tmpDir('sigmalink-ruflo-verify-root-');
    const home = tmpDir('sigmalink-ruflo-verify-home-');
    writeGoodConfigs(root, home);

    const probedCommands: string[] = [];
    const probeRunner: ProbeRunner = async (command) => {
      probedCommands.push(command);
      return { code: 0, stdout: 'ruflo', stderr: '' };
    };

    await verifyForWorkspace(root, 'strict', {
      homeDir: home,
      probeRunner,
      detectCli: noDetect, // neither kimi nor opencode detected
    });

    expect(probedCommands).not.toContain('kimi');
    expect(probedCommands).not.toContain('opencode');
  });
});
