// Writes per-provider MCP server config snippets so an agent CLI launched in
// the workspace inherits a `browser` MCP server via stdio (npx-on-demand).
//
// Idempotency: every writer searches for the SigmaLink marker (or our key)
// before appending. Re-running is safe.
//
// File targets (per `docs/02-research/skills-spec.md`):
//   • Claude Code  → `<worktree>/.mcp.json`     (project-scoped JSON)
//   • Codex CLI    → `~/.codex/config.toml`     (user-scoped TOML, append)
//   • Gemini CLI   → `~/.gemini/extensions/sigmalink-browser/gemini-extension.json`
//
// We do not rewrite existing entries from other tools. SigmaLink-owned Browser
// and SigmaMemory entries are pruned when the selected runtime profile disables
// them, so stale global MCP config cannot keep heavy tools attached.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  findTomlTableRanges,
  replaceTomlTables,
  stripMarkerLines,
  type TomlTableRange,
} from '../../lib/toml-merge';
import {
  normalizeAgentRuntimeProfileId,
  profileAllowsMcp,
  type AgentRuntimeProfileId,
} from '../../../shared/runtime-profiles';

// Legacy marker comments. Codex's own TOML rewriter strips/relocates comments,
// which orphaned the old start+end marker-pair regex → a fresh
// `[mcp_servers.browser]` table got APPENDED on every workspace open until codex
// failed to load with a duplicate-key error (B1). We no longer key off markers:
// the codex writer now collapses tables by NAME (marker-independent) and sweeps
// any of these legacy markers a previous version left behind.
const LEGACY_MARKERS = [
  '# sigmalink-browser',
  '# end sigmalink-browser',
  '# sigmalink-memory',
  '# end sigmalink-memory',
] as const;

/**
 * v1.2.6 — browser MCP is now stdio (npx-on-demand) instead of an HTTP
 * supervisor. Each agent pane spawns its own `@playwright/mcp` process.
 * The `memory` stdio server (our internal mcp-memory-server.cjs) is
 * unchanged.
 */
interface WriteOptions {
  worktree: string;
  /**
   * RAM Brake — undefined normalizes to `ruflo-core`, which intentionally does
   * not write Browser/SigmaMemory MCP. Callers must opt into `browser-tools`.
   */
  runtimeProfileId?: AgentRuntimeProfileId;
  /**
   * Optional Phase-5 SigmaMemory stdio server. When supplied, the writer
   * adds a `sigmamemory` server entry alongside the `browser` stdio entry so
   * agent CLIs see both tool sets in the same `.mcp.json`.
   */
  memory?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

// v1.2.6 — pinned version for reproducibility. Update when testing a new
// `@playwright/mcp` release.
const PLAYWRIGHT_MCP_VERSION = '0.0.75';

export function writeMcpConfigForAgent(opts: WriteOptions): {
  claude: string | null;
  codex: string | null;
  gemini: string | null;
} {
  const runtimeProfileId = normalizeAgentRuntimeProfileId(opts.runtimeProfileId);
  const allowBrowser = profileAllowsMcp(runtimeProfileId, 'browser');
  const allowMemory = profileAllowsMcp(runtimeProfileId, 'sigmamemory');
  const effectiveOpts: WriteOptions = {
    ...opts,
    runtimeProfileId,
    memory: allowMemory ? opts.memory : undefined,
  };

  return {
    claude: writeClaudeMcpJson(effectiveOpts, allowBrowser),
    codex: writeCodexConfigToml(effectiveOpts, allowBrowser),
    gemini: writeGeminiExtension(effectiveOpts, allowBrowser),
  };
}

// ─────────────────────────────────────────── Claude Code ──

function writeClaudeMcpJson(opts: WriteOptions, allowBrowser: boolean): string | null {
  try {
    const target = path.join(opts.worktree, '.mcp.json');
    if (!allowBrowser && !opts.memory && !fs.existsSync(target)) return null;
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
    delete (existing.mcpServers as Record<string, unknown>).browser;
    delete (existing.mcpServers as Record<string, unknown>).sigmamemory;
    if (allowBrowser) {
      (existing.mcpServers as Record<string, unknown>).browser = {
        command: 'npx',
        args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`],
      };
    }
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

function removeTomlTables(source: string, ranges: TomlTableRange[]): string {
  let next = source;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, range.start) + next.slice(range.end);
  }
  return next.trimEnd();
}

function writeCodexConfigToml(opts: WriteOptions, allowBrowser: boolean): string | null {
  try {
    const home = os.homedir();
    const dir = path.join(home, '.codex');
    const target = path.join(dir, 'config.toml');
    if (!allowBrowser && !opts.memory && !fs.existsSync(target)) return null;
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

    // Idempotency is TABLE-NAME-based, not marker-based (B1). Codex rewrites its
    // own config.toml and moves/strips comments, so a marker-anchored regex
    // can't reliably find our prior block → it would append a duplicate
    // `[mcp_servers.browser]` table → TOML duplicate-key → codex fails to load.
    // Instead: sweep any legacy markers, then collapse ALL `mcp_servers.browser`
    // (and `mcp_servers.sigmamemory[.*]`) tables to exactly one fresh block by
    // name. `replaceTomlTables` is a stable fixpoint (re-running re-collapses).
    // The accumulator threads browser → memory so the second collapse sees the
    // first's output (never clobbers it).
    let next = stripMarkerLines(existing, LEGACY_MARKERS);

    if (allowBrowser) {
      const browserBlock = [
        '[mcp_servers.browser]',
        'transport = "stdio"',
        `command = "npx"`,
        `args = ["-y", "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"]`,
      ].join('\n');
      next = replaceTomlTables(next, findTomlTableRanges(next, 'mcp_servers.browser'), browserBlock);
    } else {
      next = removeTomlTables(next, findTomlTableRanges(next, 'mcp_servers.browser'));
    }

    if (opts.memory) {
      const envLines = Object.entries(opts.memory.env).map(
        ([k, v]) => `${k} = ${JSON.stringify(v)}`,
      );
      const memoryBlock = [
        '[mcp_servers.sigmamemory]',
        'transport = "stdio"',
        `command = ${JSON.stringify(opts.memory.command)}`,
        `args = ${JSON.stringify(opts.memory.args)}`,
        '[mcp_servers.sigmamemory.env]',
        ...envLines,
      ].join('\n');
      next = replaceTomlTables(
        next,
        findTomlTableRanges(next, 'mcp_servers.sigmamemory'),
        memoryBlock,
      );
    } else {
      next = removeTomlTables(next, findTomlTableRanges(next, 'mcp_servers.sigmamemory'));
    }

    fs.writeFileSync(target, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
    return target;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────── Gemini CLI ──

function writeGeminiExtension(opts: WriteOptions, allowBrowser: boolean): string | null {
  try {
    const home = os.homedir();
    const dir = path.join(home, '.gemini', 'extensions', 'sigmalink-browser');
    const target = path.join(dir, 'gemini-extension.json');
    if (!allowBrowser && !opts.memory && !fs.existsSync(target)) return null;
    let existing: { mcpServers?: Record<string, unknown> } = {};
    if (fs.existsSync(target)) {
      try {
        existing = JSON.parse(fs.readFileSync(target, 'utf8')) as typeof existing;
      } catch {
        existing = {};
      }
    }
    const mcpServers: Record<string, unknown> =
      existing.mcpServers && typeof existing.mcpServers === 'object'
        ? existing.mcpServers
        : {};
    delete mcpServers.browser;
    delete mcpServers.sigmamemory;
    if (allowBrowser) {
      mcpServers.browser = {
        command: 'npx',
        args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`],
      };
    }
    if (opts.memory) {
      mcpServers.sigmamemory = {
        command: opts.memory.command,
        args: opts.memory.args,
        env: opts.memory.env,
      };
    }
    if (Object.keys(mcpServers).length === 0) {
      fs.rmSync(target, { force: true });
      return target;
    }
    fs.mkdirSync(dir, { recursive: true });
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
