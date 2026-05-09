// P3-S1 — guards against the Gemini `httpUrl` regression. Snapshots the
// produced config files and asserts the Gemini extension uses `url` (not
// `httpUrl`) for the browser MCP server. Codex TOML must keep `url`.
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

test('Gemini extension uses `url` (not `httpUrl`) for browser MCP server', () => {
  withFakeHome((home) => {
    const worktree = makeTmpDir('sigmalink-mcp-test-');
    const out = writeMcpConfigForAgent({ worktree, mcpUrl: 'http://127.0.0.1:9999/mcp' });
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
    assert.deepEqual(manifest.mcpServers.browser, { url: 'http://127.0.0.1:9999/mcp' });
    assert.ok(
      !('httpUrl' in manifest.mcpServers.browser),
      'Gemini browser entry must not contain `httpUrl`',
    );
  });
});

test('Codex TOML uses `url` for browser MCP server', () => {
  withFakeHome((home) => {
    const worktree = makeTmpDir('sigmalink-mcp-test-');
    const out = writeMcpConfigForAgent({ worktree, mcpUrl: 'http://127.0.0.1:9999/mcp' });
    assert.ok(out.codex, 'expected codex path');
    const codexPath = path.join(home, '.codex', 'config.toml');
    assert.equal(out.codex, codexPath);
    const toml = fs.readFileSync(codexPath, 'utf8');
    assert.match(toml, /\[mcp_servers\.browser\]/);
    assert.match(toml, /url = "http:\/\/127\.0\.0\.1:9999\/mcp"/);
    assert.doesNotMatch(toml, /httpUrl/);
  });
});

test('Claude .mcp.json uses `url` for browser MCP server', () => {
  withFakeHome(() => {
    const worktree = makeTmpDir('sigmalink-mcp-test-');
    const out = writeMcpConfigForAgent({ worktree, mcpUrl: 'http://127.0.0.1:9999/mcp' });
    assert.ok(out.claude, 'expected claude path');
    assert.equal(out.claude, path.join(worktree, '.mcp.json'));
    const json = JSON.parse(fs.readFileSync(out.claude!, 'utf8'));
    assert.deepEqual(json.mcpServers.browser, {
      type: 'http',
      url: 'http://127.0.0.1:9999/mcp',
    });
  });
});
