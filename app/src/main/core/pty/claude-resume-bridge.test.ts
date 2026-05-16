// v1.3.2 — Tests for the Claude session-slug bridge.
//
// These tests pin the contract of `prepareClaudeResume` + `ensureClaudeProjectDir`
// so the v1.3.1 production bug (BOTH Claude panes blank — Pane 1 because the
// `--resume` JSONL was under the workspace slug and Claude was spawned in the
// worktree slug; Pane 2 because the worktree slug dir did not exist when Claude
// tried to write its `--session-id` JSONL) cannot silently regress.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claudeSlugForCwd,
  ensureClaudeProjectDir,
  prepareClaudeResume,
  prepareClaudeWorkspaceContext,
} from './claude-resume-bridge.ts';

const VALID_UUID = '01234567-89ab-4cde-9f01-23456789abcd';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-bridge-'));
}

function rmRf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function seedSourceJsonl(
  homeDir: string,
  workspaceCwd: string,
  sessionId: string,
  payload = '{"type":"system","seed":true}\n',
): string {
  const slug = claudeSlugForCwd(workspaceCwd);
  const dir = path.join(homeDir, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, payload, 'utf8');
  return filePath;
}

describe('claudeSlugForCwd', () => {
  it('mirrors the Claude CLI convention of replacing path separators', () => {
    expect(claudeSlugForCwd('/Users/dev/projects/SigmaLink/app')).toBe(
      '-Users-dev-projects-SigmaLink-app',
    );
  });
});

describe('ensureClaudeProjectDir', () => {
  let homeDir: string;
  beforeEach(() => {
    homeDir = makeTmpHome();
  });
  afterEach(() => {
    rmRf(homeDir);
  });

  it('creates the worktree-slug project dir for fresh spawns', async () => {
    const cwd = '/tmp/worktree-pane-1';
    const result = await ensureClaudeProjectDir(cwd, { homeDir });
    expect(result).not.toBeNull();
    expect(
      fs.existsSync(path.join(homeDir, '.claude', 'projects', claudeSlugForCwd(cwd))),
    ).toBe(true);
  });

  it('is idempotent — second call returns the same dir without throwing', async () => {
    const cwd = '/tmp/worktree-pane-1';
    const first = await ensureClaudeProjectDir(cwd, { homeDir });
    const second = await ensureClaudeProjectDir(cwd, { homeDir });
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  it('refuses non-absolute paths', async () => {
    const result = await ensureClaudeProjectDir('relative/dir', { homeDir });
    expect(result).toBeNull();
  });

  it('refuses paths containing ".." traversal segments', async () => {
    const result = await ensureClaudeProjectDir('/tmp/../etc', { homeDir });
    expect(result).toBeNull();
  });
});

describe('prepareClaudeResume — happy path', () => {
  let homeDir: string;
  const workspaceCwd = '/tmp/sigmalink-workspace';
  const worktreeCwd = '/tmp/sigmalink-worktree-pane-0';

  beforeEach(() => {
    homeDir = makeTmpHome();
  });
  afterEach(() => {
    rmRf(homeDir);
  });

  it('symlinks the workspace-slug JSONL into the worktree-slug dir', async () => {
    seedSourceJsonl(homeDir, workspaceCwd, VALID_UUID);
    const outcome = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir,
    });
    expect(outcome).toBe('linked');
    const targetPath = path.join(
      homeDir,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
      `${VALID_UUID}.jsonl`,
    );
    const stat = fs.lstatSync(targetPath);
    expect(stat.isSymbolicLink()).toBe(true);
    // Read-through must surface the seed payload — proves the link target is
    // the workspace file, not a copy.
    const contents = fs.readFileSync(targetPath, 'utf8');
    expect(contents).toContain('"seed":true');
  });

  it('points the symlink at the ABSOLUTE source path (so cwd changes are safe)', async () => {
    const sourcePath = seedSourceJsonl(homeDir, workspaceCwd, VALID_UUID);
    await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, { homeDir });
    const targetPath = path.join(
      homeDir,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
      `${VALID_UUID}.jsonl`,
    );
    const linkTarget = fs.readlinkSync(targetPath);
    expect(path.isAbsolute(linkTarget)).toBe(true);
    expect(linkTarget).toBe(sourcePath);
  });

  it('writes appended JSONL back to the original workspace file (unified history)', async () => {
    seedSourceJsonl(homeDir, workspaceCwd, VALID_UUID);
    await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, { homeDir });
    const targetPath = path.join(
      homeDir,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
      `${VALID_UUID}.jsonl`,
    );
    // Simulate Claude appending a follow-up turn after resume:
    fs.appendFileSync(targetPath, '{"type":"user","text":"hi"}\n', 'utf8');
    // The workspace-slug source file must observe the append because the
    // worktree-slug path is a symlink, not a copy.
    const sourcePath = path.join(
      homeDir,
      '.claude',
      'projects',
      claudeSlugForCwd(workspaceCwd),
      `${VALID_UUID}.jsonl`,
    );
    expect(fs.readFileSync(sourcePath, 'utf8')).toContain('"text":"hi"');
  });
});

describe('prepareClaudeResume — idempotency', () => {
  let homeDir: string;
  beforeEach(() => {
    homeDir = makeTmpHome();
  });
  afterEach(() => {
    rmRf(homeDir);
  });

  it('a second call after a successful link returns "exists" — no rewrite', async () => {
    const workspaceCwd = '/tmp/ws-idempotent';
    const worktreeCwd = '/tmp/wt-idempotent';
    seedSourceJsonl(homeDir, workspaceCwd, VALID_UUID);
    const first = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir,
    });
    expect(first).toBe('linked');
    const second = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir,
    });
    expect(second).toBe('exists');
  });

  it('does not throw when the target already exists as a regular file', async () => {
    // Simulates an old SigmaLink build that copied (rather than symlinked) the
    // JSONL into the worktree-slug dir. We must not overwrite or throw.
    const workspaceCwd = '/tmp/ws-existing-file';
    const worktreeCwd = '/tmp/wt-existing-file';
    seedSourceJsonl(homeDir, workspaceCwd, VALID_UUID);
    const worktreeDir = path.join(
      homeDir,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
    );
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, `${VALID_UUID}.jsonl`),
      '{"prev":"copy"}\n',
      'utf8',
    );
    const outcome = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir,
    });
    expect(outcome).toBe('exists');
  });
});

describe('prepareClaudeResume — failure & fallback paths', () => {
  let homeDir: string;
  beforeEach(() => {
    homeDir = makeTmpHome();
  });
  afterEach(() => {
    rmRf(homeDir);
  });

  it('returns "missing" when the workspace-slug JSONL does not exist (caller falls back to --continue)', async () => {
    const outcome = await prepareClaudeResume(
      '/tmp/ws-no-source',
      '/tmp/wt-no-source',
      VALID_UUID,
      { homeDir },
    );
    expect(outcome).toBe('missing');
  });

  it('returns "skipped" when workspaceCwd === worktreeCwd (slugs already match)', async () => {
    const cwd = '/tmp/ws-equals-wt';
    seedSourceJsonl(homeDir, cwd, VALID_UUID);
    const outcome = await prepareClaudeResume(cwd, cwd, VALID_UUID, { homeDir });
    expect(outcome).toBe('skipped');
  });

  it('returns "skipped" when the session id is not UUID-shaped', async () => {
    const outcome = await prepareClaudeResume(
      '/tmp/ws',
      '/tmp/wt',
      'not-a-uuid-at-all',
      { homeDir },
    );
    expect(outcome).toBe('skipped');
  });

  it('refuses workspaceCwd containing ".." traversal', async () => {
    const outcome = await prepareClaudeResume(
      '/tmp/../etc',
      '/tmp/wt',
      VALID_UUID,
      { homeDir },
    );
    expect(outcome).toBe('skipped');
  });

  it('refuses worktreeCwd containing ".." traversal', async () => {
    const outcome = await prepareClaudeResume(
      '/tmp/ws',
      '/tmp/../etc',
      VALID_UUID,
      { homeDir },
    );
    expect(outcome).toBe('skipped');
  });

  it('refuses relative workspaceCwd', async () => {
    const outcome = await prepareClaudeResume(
      'relative/ws',
      '/tmp/wt',
      VALID_UUID,
      { homeDir },
    );
    expect(outcome).toBe('skipped');
  });
});

describe('prepareClaudeResume — realistic SigmaLink path shapes', () => {
  // Mirror the exact filesystem layout the v1.3.2 hotfix bug report describes:
  // workspace at `/Users/aisigma/projects/SigmaLink/app`, worktree under
  // `~/Library/Application Support/SigmaLink/worktrees/<repo-hash>/<branch>`.
  let homeDir: string;
  beforeEach(() => {
    homeDir = makeTmpHome();
  });
  afterEach(() => {
    rmRf(homeDir);
  });

  it('produces distinct slugs for the workspace vs worktree paths shown in the bug report', () => {
    const workspaceCwd = '/Users/aisigma/projects/SigmaLink/app';
    const worktreeCwd =
      '/Users/aisigma/Library/Application Support/SigmaLink/worktrees/abc123/claude-pane-1-deadbeef';
    expect(claudeSlugForCwd(workspaceCwd)).not.toBe(claudeSlugForCwd(worktreeCwd));
    expect(claudeSlugForCwd(workspaceCwd)).toBe(
      '-Users-aisigma-projects-SigmaLink-app',
    );
  });

  it('symlinks across the real-world workspace/worktree pair', async () => {
    const workspaceCwd = '/Users/aisigma/projects/SigmaLink/app';
    const worktreeCwd =
      '/Users/aisigma/Library/Application Support/SigmaLink/worktrees/abc123/claude-pane-1-deadbeef';
    seedSourceJsonl(homeDir, workspaceCwd, VALID_UUID, '{"history":"real"}\n');
    const outcome = await prepareClaudeResume(workspaceCwd, worktreeCwd, VALID_UUID, {
      homeDir,
    });
    expect(outcome).toBe('linked');
    const targetPath = path.join(
      homeDir,
      '.claude',
      'projects',
      claudeSlugForCwd(worktreeCwd),
      `${VALID_UUID}.jsonl`,
    );
    expect(fs.readFileSync(targetPath, 'utf8')).toContain('"history":"real"');
  });
});

describe('prepareClaudeWorkspaceContext', () => {
  let tmpRoot: string;
  let workspaceCwd: string;
  let worktreeCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-context-'));
    workspaceCwd = path.join(tmpRoot, 'workspace', 'app');
    worktreeCwd = path.join(tmpRoot, 'worktree', 'app');
    fs.mkdirSync(path.join(workspaceCwd, '.claude'), { recursive: true });
    fs.mkdirSync(worktreeCwd, { recursive: true });
    fs.writeFileSync(path.join(workspaceCwd, 'CLAUDE.md'), '# local instructions\n');
    fs.writeFileSync(path.join(workspaceCwd, '.claude', 'settings.json'), '{"ok":true}\n');
  });

  afterEach(() => {
    rmRf(tmpRoot);
  });

  it('links ignored workspace-local Claude context into the worktree cwd', async () => {
    const outcome = await prepareClaudeWorkspaceContext(workspaceCwd, worktreeCwd);

    expect(outcome.linked.sort()).toEqual(['.claude', 'CLAUDE.md'].sort());
    const claudeMd = path.join(worktreeCwd, 'CLAUDE.md');
    const claudeDir = path.join(worktreeCwd, '.claude');
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(claudeDir).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(claudeMd, 'utf8')).toContain('local instructions');
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toContain('"ok":true');
  });

  it('is idempotent and never overwrites existing worktree files', async () => {
    fs.writeFileSync(path.join(worktreeCwd, 'CLAUDE.md'), '# worktree override\n');

    const first = await prepareClaudeWorkspaceContext(workspaceCwd, worktreeCwd);
    const second = await prepareClaudeWorkspaceContext(workspaceCwd, worktreeCwd);

    expect(first.existing).toContain('CLAUDE.md');
    expect(second.existing.sort()).toEqual(['.claude', 'CLAUDE.md'].sort());
    expect(fs.readFileSync(path.join(worktreeCwd, 'CLAUDE.md'), 'utf8')).toContain(
      'worktree override',
    );
  });

  it('reports missing context without failing the pane spawn path', async () => {
    rmRf(path.join(workspaceCwd, '.claude'));
    fs.rmSync(path.join(workspaceCwd, 'CLAUDE.md'));

    const outcome = await prepareClaudeWorkspaceContext(workspaceCwd, worktreeCwd);

    expect(outcome.missing.sort()).toEqual(['.claude', 'CLAUDE.md'].sort());
    expect(outcome.linked).toHaveLength(0);
  });
});
