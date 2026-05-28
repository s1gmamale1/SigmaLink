// SF-15 — per-worktree Ruflo MCP config + trust.
//
// These tests use real temp dirs (fs is NOT mocked) to mirror mcp-autowrite.test.ts.
// They assert the ruflo server lands in the pane's ACTUAL cwd (its worktree),
// because the spawned CLI reads MCP config relative to its cwd — NOT the
// workspace root where openWorkspace's autowrite/trust ran.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeRufloMcpIntoCwd } from './ruflo-worktree-mcp';

const tmpDirs: string[] = [];
const quietLogger = { warn: () => undefined };

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface McpJson {
  mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }>;
}

function readMcp(cwd: string): McpJson {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')) as McpJson;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('writeRufloMcpIntoCwd', () => {
  it('writes a stdio ruflo entry into <cwd>/.mcp.json when no port is given', () => {
    const cwd = tmpDir('rwm-stdio-');
    const result = writeRufloMcpIntoCwd(cwd, { logger: quietLogger });

    expect(result.claude).toBe(path.join(cwd, '.mcp.json'));
    const doc = readMcp(cwd);
    expect(doc.mcpServers?.ruflo).toBeDefined();
    expect(doc.mcpServers?.ruflo?.command).toBe('npx');
    // stdio entry carries no url
    expect(doc.mcpServers?.ruflo?.url).toBeUndefined();
    // CLAUDE_FLOW_DIR points at the worktree cwd (not the workspace root)
    expect(doc.mcpServers?.ruflo?.env?.CLAUDE_FLOW_DIR).toBe(path.join(cwd, '.claude-flow'));
  });

  it('writes an HTTP ruflo entry into <cwd>/.mcp.json when a port is given', () => {
    const cwd = tmpDir('rwm-http-');
    writeRufloMcpIntoCwd(cwd, { port: 54321, logger: quietLogger });

    const doc = readMcp(cwd);
    expect(doc.mcpServers?.ruflo?.url).toBe('http://127.0.0.1:54321/mcp');
    // HTTP entry carries no command
    expect(doc.mcpServers?.ruflo?.command).toBeUndefined();
  });

  it('preserves co-tenant servers (browser/sigmamemory) already in .mcp.json', () => {
    const cwd = tmpDir('rwm-coexist-');
    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.75'] } } }, null, 2),
    );
    writeRufloMcpIntoCwd(cwd, { logger: quietLogger });

    const doc = readMcp(cwd);
    expect(doc.mcpServers?.browser).toBeDefined();
    expect(doc.mcpServers?.ruflo).toBeDefined();
  });

  it('refuses to clobber a user-managed ruflo entry', () => {
    const cwd = tmpDir('rwm-user-');
    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { ruflo: { command: 'my-own-ruflo', args: ['serve'] } } }, null, 2),
    );
    const result = writeRufloMcpIntoCwd(cwd, { logger: quietLogger });

    expect(result.claude).toBeNull();
    const doc = readMcp(cwd);
    expect(doc.mcpServers?.ruflo?.command).toBe('my-own-ruflo');
  });

  it('writes the claude trust file into <cwd>/.claude/settings.local.json', () => {
    const cwd = tmpDir('rwm-trust-');
    writeRufloMcpIntoCwd(cwd, { logger: quietLogger });

    const trust = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    ) as { enabledMcpjsonServers?: string[] };
    expect(trust.enabledMcpjsonServers).toContain('ruflo');
  });

  it('never throws when the cwd is unwritable (fail-open)', () => {
    // A path under a regular file is not a directory → fs ops throw internally.
    const base = tmpDir('rwm-failopen-');
    const filePath = path.join(base, 'afile');
    fs.writeFileSync(filePath, 'x');
    const cwd = path.join(filePath, 'nested'); // parent is a file
    expect(() => writeRufloMcpIntoCwd(cwd, { logger: quietLogger })).not.toThrow();
  });

  it('is idempotent — a second call produces a byte-identical .mcp.json', () => {
    const cwd = tmpDir('rwm-idem-');
    writeRufloMcpIntoCwd(cwd, { port: 40000, logger: quietLogger });
    const first = fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8');
    writeRufloMcpIntoCwd(cwd, { port: 40000, logger: quietLogger });
    const second = fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8');
    expect(second).toBe(first);
  });

  it('skips trust when trust:false is passed (autowrite-without-autotrust)', () => {
    const cwd = tmpDir('rwm-notrust-');
    writeRufloMcpIntoCwd(cwd, { trust: false, logger: quietLogger });
    expect(fs.existsSync(path.join(cwd, '.claude', 'settings.local.json'))).toBe(false);
    // MCP config still written
    expect(fs.existsSync(path.join(cwd, '.mcp.json'))).toBe(true);
  });
});
