// Writes per-provider MCP server config snippets so an agent CLI launched in
// the workspace inherits a `browser` MCP server pointing at our managed
// Playwright endpoint.
//
// Idempotency: every writer searches for the SigmaLink marker (or our key)
// before appending. Re-running is safe.
//
// File targets (per `docs/02-research/skills-spec.md`):
//   • Claude Code  → `<worktree>/.mcp.json`     (project-scoped JSON)
//   • Codex CLI    → `~/.codex/config.toml`     (user-scoped TOML, append)
//   • Gemini CLI   → `~/.gemini/extensions/sigmalink-browser/gemini-extension.json`
//
// We do not delete or rewrite existing entries from other tools — additive only.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const MARKER = '# sigmalink-browser';
const MEMORY_MARKER = '# sigmalink-memory';

interface WriteOptions {
  worktree: string;
  mcpUrl: string;
  /**
   * Optional Phase-5 SigmaMemory stdio server. When supplied, the writer
   * adds a `sigmamemory` server entry alongside the `browser` HTTP entry so
   * agent CLIs see both tool sets in the same `.mcp.json`.
   */
  memory?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

export function writeMcpConfigForAgent(opts: WriteOptions): {
  claude: string | null;
  codex: string | null;
  gemini: string | null;
} {
  return {
    claude: writeClaudeMcpJson(opts),
    codex: writeCodexConfigToml(opts),
    gemini: writeGeminiExtension(opts),
  };
}

// ─────────────────────────────────────────── Claude Code ──

function writeClaudeMcpJson(opts: WriteOptions): string | null {
  try {
    const target = path.join(opts.worktree, '.mcp.json');
    let existing: { mcpServers?: Record<string, unknown> } = {};
    if (fs.existsSync(target)) {
      try {
        existing = JSON.parse(fs.readFileSync(target, 'utf8')) as typeof existing;
      } catch {
        existing = {};
      }
    }
    if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
      existing.mcpServers = {};
    }
    (existing.mcpServers as Record<string, unknown>).browser = {
      type: 'http',
      url: opts.mcpUrl,
    };
    if (opts.memory) {
      (existing.mcpServers as Record<string, unknown>).sigmamemory = {
        type: 'stdio',
        command: opts.memory.command,
        args: opts.memory.args,
        env: opts.memory.env,
      };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return target;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────── Codex CLI ──

function writeCodexConfigToml(opts: WriteOptions): string | null {
  try {
    const home = os.homedir();
    const dir = path.join(home, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'config.toml');
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

    // Idempotency: search for the marker; if present, replace the block.
    const browserBlock = [
      MARKER,
      '[mcp_servers.browser]',
      'transport = "http"',
      `url = "${opts.mcpUrl}"`,
      '# end sigmalink-browser',
      '',
    ].join('\n');

    let next = existing;
    if (existing.includes(MARKER)) {
      next = next.replace(
        /# sigmalink-browser[\s\S]*?# end sigmalink-browser\n?/m,
        browserBlock,
      );
    } else {
      const sep = next.length === 0 || next.endsWith('\n') ? '' : '\n';
      next = next + sep + '\n' + browserBlock;
    }

    if (opts.memory) {
      const envLines = Object.entries(opts.memory.env).map(
        ([k, v]) => `  ${k} = ${JSON.stringify(v)}`,
      );
      const memoryBlock = [
        MEMORY_MARKER,
        '[mcp_servers.sigmamemory]',
        'transport = "stdio"',
        `command = ${JSON.stringify(opts.memory.command)}`,
        `args = ${JSON.stringify(opts.memory.args)}`,
        '[mcp_servers.sigmamemory.env]',
        ...envLines,
        '# end sigmalink-memory',
        '',
      ].join('\n');
      if (next.includes(MEMORY_MARKER)) {
        next = next.replace(
          /# sigmalink-memory[\s\S]*?# end sigmalink-memory\n?/m,
          memoryBlock,
        );
      } else {
        const sep = next.length === 0 || next.endsWith('\n') ? '' : '\n';
        next = next + sep + '\n' + memoryBlock;
      }
    }

    fs.writeFileSync(target, next, 'utf8');
    return target;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────── Gemini CLI ──

function writeGeminiExtension(opts: WriteOptions): string | null {
  try {
    const home = os.homedir();
    const dir = path.join(home, '.gemini', 'extensions', 'sigmalink-browser');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'gemini-extension.json');
    const mcpServers: Record<string, unknown> = {
      browser: { httpUrl: opts.mcpUrl },
    };
    if (opts.memory) {
      mcpServers.sigmamemory = {
        command: opts.memory.command,
        args: opts.memory.args,
        env: opts.memory.env,
      };
    }
    const manifest = {
      name: 'sigmalink-browser',
      version: '1.0.0',
      description: 'SigmaLink in-app browser + memory hub, exposed over MCP.',
      mcpServers,
    };
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return target;
  } catch {
    return null;
  }
}
