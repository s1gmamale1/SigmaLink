// P6 FEAT-5 — MCP config diagnostics tests.
//
// We drive the real read+parse path against a per-test tmp directory (the same
// approach as mcp-autowrite.test.ts) and a chainable MockDb fake for the
// drizzle workspace lookup. We NEVER use `new Database()` — better-sqlite3 is
// built for Electron's ABI and can't load under vitest.
//
// The tmp tree doubles as both the workspace root (project-scoped claude/cursor
// configs) AND the injected `homeDir` (user-scoped codex/gemini/kimi/opencode
// configs), so a single dir holds every provider's file.

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMcpDiagnosticController, type McpDiagnosticNotify } from './mcp-diagnostic';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  tmpDirs.length = 0;
  vi.restoreAllMocks();
});

const WS_ID = 'ws-test';

function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-diag-'));
  tmpDirs.push(dir);
  return dir;
}

/** Chainable drizzle-select fake returning the single workspace row by id. */
function fakeDb(rootPath: string | null) {
  const rows = rootPath === null ? [] : [{ id: WS_ID, rootPath }];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    all: () => rows,
  };
  // The controller only ever calls .select().from().where().all().
  return chain as unknown as ReturnType<typeof import('../db/client').getDb>;
}

/** Build a controller wired to `root` as both workspace root + homeDir. */
function buildController(root: string | null, notify?: McpDiagnosticNotify) {
  const dbRoot = root ?? '/nonexistent';
  return buildMcpDiagnosticController({
    getDb: () => fakeDb(root),
    notify,
    homeDir: dbRoot,
  });
}

function spyNotify(): McpDiagnosticNotify & { calls: Parameters<McpDiagnosticNotify['add']>[0][] } {
  const calls: Parameters<McpDiagnosticNotify['add']>[0][] = [];
  return { add: (input) => void calls.push(input), calls };
}

// ─── Config writers (relative to a single root that is both ws-root + home) ────

function writeClaude(root: string, servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

function writeCursor(root: string, servers: Record<string, unknown>): void {
  const dir = path.join(root, '.cursor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

function writeOpencode(root: string, mcp: Record<string, unknown>): void {
  const dir = path.join(root, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ mcp }, null, 2));
}

function writeCodex(root: string, body: string): void {
  const dir = path.join(root, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), body);
}

/** A managed (SigmaLink-written) ruflo stdio entry — command 'npx' + the env. */
function managedRuflo(flowDir = '/proj/.claude-flow'): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
    env: { CLAUDE_FLOW_DIR: flowDir },
  };
}

describe('mcp-diagnostic diagnoseWorkspace', () => {
  it('parses claude .mcp.json + cursor .cursor/mcp.json servers with provider/scope/managed', async () => {
    const root = makeTmpRoot();
    writeClaude(root, { ruflo: managedRuflo(), custom: { command: 'my-server', args: [] } });
    writeCursor(root, { other: { command: 'thing' } });

    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });

    const claudeRuflo = out.servers.find((s) => s.name === 'ruflo' && s.provider === 'claude');
    expect(claudeRuflo).toBeDefined();
    expect(claudeRuflo?.scope).toBe('project');
    expect(claudeRuflo?.managed).toBe(true);
    expect(claudeRuflo?.file).toBe(path.join(root, '.mcp.json'));

    const custom = out.servers.find((s) => s.name === 'custom');
    expect(custom?.managed).toBe(false);

    const cursor = out.servers.find((s) => s.provider === 'cursor' && s.name === 'other');
    expect(cursor?.scope).toBe('project');
    expect(out.scannedAt).toBeGreaterThan(0);
  });

  it('flags scope-conflict (duplicate) when one server NAME appears across two files', async () => {
    const root = makeTmpRoot();
    writeClaude(root, { shared: { command: 'a' } });
    writeCursor(root, { shared: { command: 'b' } });

    const notify = spyNotify();
    const out = await buildController(root, notify).diagnoseWorkspace({ workspaceId: WS_ID });

    const dup = out.issues.find((i) => i.kind === 'scope-conflict');
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('warn');
    expect(dup?.title).toContain('shared');
    // warn issue → one notification raised.
    expect(notify.calls.some((c) => c.kind === 'mcp-diagnostic' && c.severity === 'warn')).toBe(true);
  });

  it('flags missing-env (error) for a managed ruflo entry lacking CLAUDE_FLOW_DIR', async () => {
    const root = makeTmpRoot();
    // Managed by command='npx' but no env.CLAUDE_FLOW_DIR.
    writeClaude(root, { ruflo: { command: 'npx', args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'] } });

    const notify = spyNotify();
    const out = await buildController(root, notify).diagnoseWorkspace({ workspaceId: WS_ID });

    const missing = out.issues.find((i) => i.kind === 'missing-env');
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('error');
    expect(missing?.file).toBe(path.join(root, '.mcp.json'));
    expect(notify.calls.some((c) => c.severity === 'error')).toBe(true);
  });

  it('does NOT flag missing-env when the managed entry declares CLAUDE_FLOW_DIR', async () => {
    const root = makeTmpRoot();
    writeClaude(root, { ruflo: managedRuflo() });

    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });
    expect(out.issues.find((i) => i.kind === 'missing-env')).toBeUndefined();
  });

  it('treats a malformed JSON config as an unreadable issue and never throws', async () => {
    const root = makeTmpRoot();
    fs.writeFileSync(path.join(root, '.mcp.json'), '{ this is : not json,, ');

    const notify = spyNotify();
    const out = await buildController(root, notify).diagnoseWorkspace({ workspaceId: WS_ID });

    const unreadable = out.issues.find((i) => i.kind === 'unreadable');
    expect(unreadable).toBeDefined();
    expect(unreadable?.severity).toBe('warn');
    expect(unreadable?.file).toBe(path.join(root, '.mcp.json'));
    // no server should have been produced from the broken file.
    expect(out.servers.find((s) => s.provider === 'claude')).toBeUndefined();
    // unreadable is warn → notified.
    expect(notify.calls.some((c) => c.kind === 'mcp-diagnostic')).toBe(true);
  });

  it('parses opencode `mcp` map (different schema key) and detects its servers', async () => {
    const root = makeTmpRoot();
    writeOpencode(root, {
      ruflo: { type: 'local', command: ['npx', '-y', '@claude-flow/cli@latest', 'mcp', 'start'], environment: { CLAUDE_FLOW_DIR: '/x/.claude-flow' }, enabled: true },
    });

    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });
    const oc = out.servers.find((s) => s.provider === 'opencode' && s.name === 'ruflo');
    expect(oc).toBeDefined();
    expect(oc?.scope).toBe('user');
  });

  it('best-effort parses codex TOML mcp_servers tables + flags missing-env when env table absent', async () => {
    const root = makeTmpRoot();
    writeCodex(
      root,
      [
        '[mcp_servers.ruflo]',
        'command = "npx"',
        'args = ["-y", "@claude-flow/cli@latest", "mcp", "start"]',
        '',
      ].join('\n'),
    );

    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });
    const codex = out.servers.find((s) => s.provider === 'codex' && s.name === 'ruflo');
    expect(codex).toBeDefined();
    expect(codex?.scope).toBe('user');
    expect(codex?.managed).toBe(true);
    // No [mcp_servers.ruflo.env] table → missing-env.
    expect(out.issues.find((i) => i.kind === 'missing-env' && i.file?.endsWith('config.toml'))).toBeDefined();
  });

  it('does NOT flag codex missing-env when the env table declares CLAUDE_FLOW_DIR', async () => {
    const root = makeTmpRoot();
    writeCodex(
      root,
      [
        '[mcp_servers.ruflo]',
        'command = "npx"',
        'args = ["-y", "@claude-flow/cli@latest", "mcp", "start"]',
        '',
        '[mcp_servers.ruflo.env]',
        'CLAUDE_FLOW_DIR = "/proj/.claude-flow"',
        '',
      ].join('\n'),
    );

    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });
    expect(out.issues.find((i) => i.kind === 'missing-env')).toBeUndefined();
  });

  it('returns an empty diagnostic when no config files exist (clean workspace)', async () => {
    const root = makeTmpRoot();
    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });
    expect(out.servers).toEqual([]);
    expect(out.issues).toEqual([]);
    expect(out.workspaceId).toBe(WS_ID);
  });

  it('returns an empty diagnostic (no throw) when the workspace id is unknown', async () => {
    const out = await buildController(null).diagnoseWorkspace({ workspaceId: 'missing' });
    expect(out.servers).toEqual([]);
    expect(out.issues).toEqual([]);
  });

  it('does not raise notifications for info-only runs and works without a notify sink', async () => {
    const root = makeTmpRoot();
    writeClaude(root, { ruflo: managedRuflo() });
    // No notify provided — must not throw.
    const out = await buildController(root).diagnoseWorkspace({ workspaceId: WS_ID });
    expect(out.servers.length).toBeGreaterThan(0);
  });

  it('adds profile-specific info issues for heavy MCP servers outside the default profile without notifying', async () => {
    const root = makeTmpRoot();
    writeClaude(root, { browser: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.75'] } });

    const notify = spyNotify();
    const out = await buildController(root, notify).diagnoseWorkspace({ workspaceId: WS_ID });

    expect(out.runtimeProfileId).toBe('ruflo-core');
    expect(out.expectedServers).toEqual(['ruflo']);
    const issue = out.issues.find((i) => i.kind === 'profile-unexpected');
    expect(issue?.severity).toBe('info');
    expect(issue?.title).toContain('browser');
    expect(notify.calls).toEqual([]);
  });

  it('does not flag Browser/SigmaMemory as unexpected for browser-tools diagnostics', async () => {
    const root = makeTmpRoot();
    writeClaude(root, {
      browser: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.75'] },
      sigmamemory: { command: 'node', args: ['memory.cjs'] },
    });

    const out = await buildController(root).diagnoseWorkspace({
      workspaceId: WS_ID,
      runtimeProfileId: 'browser-tools',
    });

    expect(out.runtimeProfileId).toBe('browser-tools');
    expect(out.expectedServers).toEqual(['ruflo', 'browser', 'sigmamemory']);
    expect(out.issues.find((i) => i.kind === 'profile-unexpected')).toBeUndefined();
  });

  it('is fail-open: a throwing notify sink does not break the diagnostics pass', async () => {
    const root = makeTmpRoot();
    writeClaude(root, { ruflo: { command: 'npx', args: [] } }); // missing-env → error → notify

    const throwing: McpDiagnosticNotify = {
      add: () => {
        throw new Error('sink down');
      },
    };
    const out = await buildController(root, throwing).diagnoseWorkspace({ workspaceId: WS_ID });
    expect(out.issues.find((i) => i.kind === 'missing-env')).toBeDefined();
  });
});
