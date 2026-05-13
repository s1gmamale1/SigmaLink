// v1.2.6 — validates that the stdio browser MCP config is written correctly
// for Claude (.mcp.json), Codex (config.toml), and Gemini (extension.json).
// The browser entry is now a stdio command, not an HTTP URL.
//
// Framework: node:test (built into Node v26, no new dep).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeMcpConfigForAgent } from '../mcp-config-writer.ts';

// Tracks every tmp dir created by this spec so the trailing cleanup hook
// can remove them. Without this, each run leaks ~6 dirs into $TMPDIR.
const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function withFakeHome<T>(fn: (home: string) => T): T {
  // process.env.HOME mutation is safe here because node:test runs tests
  // within a file sequentially. POSIX-only; on Windows os.homedir() reads
  // USERPROFILE and these tests would need adjustment.
  const fakeHome = makeTmpDir('sigmalink-home-');
  const prev = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn(fakeHome);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

test.after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('Gemini extension uses stdio command for browser MCP server', () => {
  withFakeHome((home) => {
    const worktree = makeTmpDir('sigmalink-mcp-test-');
    const out = writeMcpConfigForAgent({ worktree });
    assert.ok(out.gemini, 'expected gemini path');
    const geminiManifestPath = path.join(
      home,
      '.gemini',
      'extensions',
      'sigmalink-browser',
      'gemini-extension.json',
    );
    assert.equal(out.gemini, geminiManifestPath);
    const manifest = JSON.parse(fs.readFileSync(geminiManifestPath, 'utf8'));
    assert.deepEqual(manifest.mcpServers.browser, {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.75'],
    });
    assert.ok(
      !('url' in manifest.mcpServers.browser),
      'Gemini browser entry must not contain `url` (v1.2.6 stdio mode)',
    );
  });
});

test('Codex TOML uses stdio for browser MCP server', () => {
  withFakeHome((home) => {
    const worktree = makeTmpDir('sigmalink-mcp-test-');
    const out = writeMcpConfigForAgent({ worktree });
    assert.ok(out.codex, 'expected codex path');
    const codexPath = path.join(home, '.codex', 'config.toml');
    assert.equal(out.codex, codexPath);
    const toml = fs.readFileSync(codexPath, 'utf8');
    assert.match(toml, /\[mcp_servers\.browser\]/);
    assert.match(toml, /transport = "stdio"/);
    assert.match(toml, /command = "npx"/);
    assert.match(toml, /args = \["-y", "@playwright\/mcp@0\.0\.75"\]/);
    assert.doesNotMatch(toml, /url = /);
  });
});

test('Claude .mcp.json uses stdio for browser MCP server', () => {
  withFakeHome(() => {
    const worktree = makeTmpDir('sigmalink-mcp-test-');
    const out = writeMcpConfigForAgent({ worktree });
    assert.ok(out.claude, 'expected claude path');
    assert.equal(out.claude, path.join(worktree, '.mcp.json'));
    const json = JSON.parse(fs.readFileSync(out.claude!, 'utf8'));
    assert.deepEqual(json.mcpServers.browser, {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.75'],
    });
  });
});
