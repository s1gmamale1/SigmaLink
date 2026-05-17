// v1.4.3-01 — Tests for the Gemini session-slug bridge.
//
// These tests pin the contract of `geminiSlugForCwd`, `lookupGeminiSlug`,
// `ensureGeminiProjectDir`, and `prepareGeminiResume` so the v1.4.2 production
// bug (Gemini exits code 1 on every pane spawn because:
//   a) SigmaLink was passing `gemini --resume <uuid>` — invalid for gemini;
//   b) even `--resume latest` would fail because the worktree slug's chats/
//      directory was always empty — history lived under the workspace slug)
// cannot silently regress.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  geminiSlugForCwd,
  lookupGeminiSlug,
  ensureGeminiProjectDir,
  prepareGeminiResume,
} from './gemini-resume-bridge.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-gemini-bridge-'));
}

function rmRf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/** Seed a projects.json with the given map. */
function seedProjectsJson(homeDir: string, data: Record<string, string>): void {
  const dir = path.join(homeDir, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify(data, null, 2) + '\n',
    'utf8',
  );
}

/** Create a session file under the chats directory for a given slug. */
function seedGeminiSession(homeDir: string, slug: string, sessionName?: string): string {
  const chatsDir = path.join(homeDir, '.gemini', 'tmp', slug, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const name = sessionName ?? 'session-2024-01-01T12-00-abc.jsonl';
  const filePath = path.join(chatsDir, name);
  fs.writeFileSync(filePath, '{"type":"system","seed":true}\n', 'utf8');
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. geminiSlugForCwd — derives basename when no registry entry
// ─────────────────────────────────────────────────────────────────────────────
describe('geminiSlugForCwd', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  it('returns path.basename(cwd) when projects.json is absent', async () => {
    const cwd = '/Users/dev/projects/MyApp';
    const slug = await geminiSlugForCwd(homeDir, cwd);
    expect(slug).toBe('MyApp');
  });

  it('returns path.basename(cwd) when cwd has no entry in projects.json', async () => {
    seedProjectsJson(homeDir, { '/some/other/path': 'other-slug' });
    const cwd = '/Users/dev/projects/MyApp';
    const slug = await geminiSlugForCwd(homeDir, cwd);
    expect(slug).toBe('MyApp');
  });

  // 2. geminiSlugForCwd — respects existing projects.json mapping
  it('returns the registered slug when cwd is present in projects.json', async () => {
    const cwd = '/Users/dev/projects/MyApp';
    seedProjectsJson(homeDir, { [cwd]: 'MyApp-registered' });
    const slug = await geminiSlugForCwd(homeDir, cwd);
    expect(slug).toBe('MyApp-registered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. lookupGeminiSlug
// ─────────────────────────────────────────────────────────────────────────────
describe('lookupGeminiSlug', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  // 3. returns null when projects.json is missing
  it('returns null when projects.json does not exist', async () => {
    const result = await lookupGeminiSlug(homeDir, '/any/path');
    expect(result).toBeNull();
  });

  // 4. returns null when projects.json is malformed
  it('returns null when projects.json contains invalid JSON', async () => {
    const dir = path.join(homeDir, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), '{not valid json', 'utf8');
    const result = await lookupGeminiSlug(homeDir, '/any/path');
    expect(result).toBeNull();
  });

  it('returns null when projects.json is an array (wrong schema)', async () => {
    const dir = path.join(homeDir, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), '["wrong"]', 'utf8');
    const result = await lookupGeminiSlug(homeDir, '/any/path');
    expect(result).toBeNull();
  });

  it('returns null when projects.json has non-string values', async () => {
    const dir = path.join(homeDir, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify({ '/some/path': 42 }),
      'utf8',
    );
    const result = await lookupGeminiSlug(homeDir, '/some/path');
    expect(result).toBeNull();
  });

  it('returns the slug when cwd exists in projects.json', async () => {
    const cwd = '/Users/dev/projects/MyApp';
    seedProjectsJson(homeDir, { [cwd]: 'MyApp' });
    const result = await lookupGeminiSlug(homeDir, cwd);
    expect(result).toBe('MyApp');
  });

  it('returns null when cwd is absent from a valid projects.json', async () => {
    seedProjectsJson(homeDir, { '/other/path': 'other-slug' });
    const result = await lookupGeminiSlug(homeDir, '/Users/dev/projects/MyApp');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–7. ensureGeminiProjectDir
// ─────────────────────────────────────────────────────────────────────────────
describe('ensureGeminiProjectDir', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  const workspaceCwd = '/tmp/sigmalink-workspace';
  const worktreeCwd = '/tmp/sigmalink-worktree-pane-0';

  // 5. creates ~/.gemini/tmp/<slug>/chats/ idempotently
  it('creates the chats directory for the workspace slug', async () => {
    const result = await ensureGeminiProjectDir(worktreeCwd, workspaceCwd, { homeDir });
    expect(result).not.toBeNull();
    const slug = path.basename(workspaceCwd); // fallback basename
    expect(fs.existsSync(path.join(homeDir, '.gemini', 'tmp', slug, 'chats'))).toBe(true);
  });

  it('is idempotent — second call does not throw and returns the same path', async () => {
    const first = await ensureGeminiProjectDir(worktreeCwd, workspaceCwd, { homeDir });
    const second = await ensureGeminiProjectDir(worktreeCwd, workspaceCwd, { homeDir });
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  // 6. registers worktreeCwd → workspaceSlug in projects.json
  it('writes worktreeCwd → workspaceSlug into projects.json', async () => {
    const slug = path.basename(workspaceCwd);
    await ensureGeminiProjectDir(worktreeCwd, workspaceCwd, { homeDir });
    const raw = fs.readFileSync(
      path.join(homeDir, '.gemini', 'projects.json'),
      'utf8',
    );
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map[worktreeCwd]).toBe(slug);
  });

  // 7. preserves other entries in projects.json on write
  it('preserves pre-existing entries when writing the alias', async () => {
    const otherCwd = '/some/other/project';
    seedProjectsJson(homeDir, { [otherCwd]: 'other-slug' });
    await ensureGeminiProjectDir(worktreeCwd, workspaceCwd, { homeDir });
    const raw = fs.readFileSync(
      path.join(homeDir, '.gemini', 'projects.json'),
      'utf8',
    );
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map[otherCwd]).toBe('other-slug');
    expect(map[worktreeCwd]).toBeDefined();
  });

  it('returns null when worktreeCwd is not absolute', async () => {
    const result = await ensureGeminiProjectDir('relative/path', workspaceCwd, { homeDir });
    expect(result).toBeNull();
  });

  it('returns null when workspaceCwd is not absolute', async () => {
    const result = await ensureGeminiProjectDir(worktreeCwd, 'relative/path', { homeDir });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8–11. prepareGeminiResume
// ─────────────────────────────────────────────────────────────────────────────
describe('prepareGeminiResume', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  const workspaceCwd = '/tmp/sigmalink-workspace';
  const worktreeCwd = '/tmp/sigmalink-worktree-pane-0';

  // 8. returns 'skipped' when workspaceCwd === worktreeCwd
  it('returns "skipped" when workspaceCwd equals worktreeCwd (plain workspace)', async () => {
    const cwd = '/tmp/plain-workspace';
    const outcome = await prepareGeminiResume(cwd, cwd, { homeDir });
    expect(outcome).toBe('skipped');
  });

  // 9. returns 'missing' when workspaceCwd's slug has empty chats/
  it('returns "missing" when workspace slug has no session files', async () => {
    // chatsDir exists but is empty
    const slug = path.basename(workspaceCwd);
    fs.mkdirSync(path.join(homeDir, '.gemini', 'tmp', slug, 'chats'), { recursive: true });
    const outcome = await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    expect(outcome).toBe('missing');
  });

  it('returns "missing" when the chats directory does not exist at all', async () => {
    const outcome = await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    expect(outcome).toBe('missing');
  });

  // 10. returns 'aliased' on first call (new mapping)
  it('returns "aliased" on first call when workspace has sessions', async () => {
    const slug = path.basename(workspaceCwd);
    seedGeminiSession(homeDir, slug);
    const outcome = await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    expect(outcome).toBe('aliased');
  });

  it('writes the alias into projects.json on "aliased" path', async () => {
    const slug = path.basename(workspaceCwd);
    seedGeminiSession(homeDir, slug);
    await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    const raw = fs.readFileSync(
      path.join(homeDir, '.gemini', 'projects.json'),
      'utf8',
    );
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map[worktreeCwd]).toBe(slug);
  });

  // 11. returns 'exists' on second call (idempotent)
  it('returns "exists" on second call — idempotent', async () => {
    const slug = path.basename(workspaceCwd);
    seedGeminiSession(homeDir, slug);
    const first = await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    expect(first).toBe('aliased');
    const second = await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    expect(second).toBe('exists');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Traversal refusal
// ─────────────────────────────────────────────────────────────────────────────
describe('traversal refusal', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  it('prepareGeminiResume returns "skipped" for workspaceCwd with ".." segment', async () => {
    const outcome = await prepareGeminiResume('/tmp/../etc', '/tmp/worktree', { homeDir });
    expect(outcome).toBe('skipped');
  });

  it('prepareGeminiResume returns "skipped" for worktreeCwd with ".." segment', async () => {
    const outcome = await prepareGeminiResume('/tmp/workspace', '/tmp/../etc', { homeDir });
    expect(outcome).toBe('skipped');
  });

  it('ensureGeminiProjectDir returns null for worktreeCwd with ".." segment', async () => {
    const result = await ensureGeminiProjectDir('/tmp/../etc', '/tmp/workspace', { homeDir });
    expect(result).toBeNull();
  });

  it('ensureGeminiProjectDir returns null for workspaceCwd with ".." segment', async () => {
    const result = await ensureGeminiProjectDir('/tmp/worktree', '/tmp/../etc', { homeDir });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Absolute-path requirement
// ─────────────────────────────────────────────────────────────────────────────
describe('absolute-path requirement', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  it('prepareGeminiResume returns "skipped" for relative workspaceCwd', async () => {
    const outcome = await prepareGeminiResume('relative/ws', '/tmp/worktree', { homeDir });
    expect(outcome).toBe('skipped');
  });

  it('prepareGeminiResume returns "skipped" for relative worktreeCwd', async () => {
    const outcome = await prepareGeminiResume('/tmp/workspace', 'relative/wt', { homeDir });
    expect(outcome).toBe('skipped');
  });

  it('ensureGeminiProjectDir returns null for relative worktreeCwd', async () => {
    const result = await ensureGeminiProjectDir('relative/wt', '/tmp/workspace', { homeDir });
    expect(result).toBeNull();
  });

  it('ensureGeminiProjectDir returns null for relative workspaceCwd', async () => {
    const result = await ensureGeminiProjectDir('/tmp/worktree', 'relative/ws', { homeDir });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic SigmaLink path shapes
// ─────────────────────────────────────────────────────────────────────────────
describe('prepareGeminiResume — realistic SigmaLink path shapes', () => {
  let homeDir: string;
  beforeEach(() => { homeDir = makeTmpHome(); });
  afterEach(() => { rmRf(homeDir); });

  it('produces the correct alias for a real workspace/worktree pair', async () => {
    const workspaceCwd = '/Users/aisigma/projects/SigmaLink/app';
    const worktreeCwd =
      '/Users/aisigma/Library/Application Support/SigmaLink/worktrees/abc123/gemini-pane-1-deadbeef';
    const slug = path.basename(workspaceCwd); // 'app'
    seedGeminiSession(homeDir, slug);

    const outcome = await prepareGeminiResume(workspaceCwd, worktreeCwd, { homeDir });
    expect(outcome).toBe('aliased');

    const raw = fs.readFileSync(
      path.join(homeDir, '.gemini', 'projects.json'),
      'utf8',
    );
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map[worktreeCwd]).toBe(slug);
    expect(map[workspaceCwd]).toBeUndefined(); // workspace entry not touched by bridge
  });
});
