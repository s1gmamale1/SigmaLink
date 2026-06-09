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
  repairClaudeGlobalConfig,
} from './claude-resume-sigma.ts';

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

describe('repairClaudeGlobalConfig', () => {
  let home: string;
  const cfg = () => path.join(home, '.claude.json');

  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => rmRf(home));

  it('returns missing when ~/.claude.json does not exist', async () => {
    expect(await repairClaudeGlobalConfig({ homeDir: home })).toBe('missing');
  });

  it('returns ok and leaves a valid file byte-for-byte untouched', async () => {
    const body = '{\n  "numStartups": 7,\n  "projects": {}\n}\n';
    fs.writeFileSync(cfg(), body, 'utf8');
    expect(await repairClaudeGlobalConfig({ homeDir: home })).toBe('ok');
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(body);
  });

  it('repairs trailing garbage (hard-kill mid-rewrite) and keeps a forensic copy', async () => {
    // The exact production shape: a complete shorter JSON document followed by
    // the un-truncated tail of the previous longer version.
    const valid = '{\n  "numStartups": 8,\n  "tipsHistory": { "color-when-multi-clauding": 1 }\n}';
    const tail = '-workflows@ruflo": {\n  "usageCount": 0,\n  "lastUsedAt": 1781034447565\n},';
    fs.writeFileSync(cfg(), valid + tail, 'utf8');

    expect(await repairClaudeGlobalConfig({ homeDir: home })).toBe('repaired');

    const repaired = fs.readFileSync(cfg(), 'utf8');
    expect(repaired).toBe(valid);
    expect(() => JSON.parse(repaired)).not.toThrow();
    const corruptCopies = fs
      .readdirSync(home)
      .filter((n) => n.startsWith('.claude.json.corrupt-'));
    expect(corruptCopies).toHaveLength(1);
  });

  it('does not respect braces inside JSON strings as structure', async () => {
    const valid = '{ "a": "br{ace}s \\" in } strings" }';
    fs.writeFileSync(cfg(), `${valid}GARBAGE}}`, 'utf8');
    expect(await repairClaudeGlobalConfig({ homeDir: home })).toBe('repaired');
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(valid);
  });

  it('leaves a truly truncated file untouched (unrepairable)', async () => {
    const truncated = '{ "numStartups": 8, "projects": { "c--users"';
    fs.writeFileSync(cfg(), truncated, 'utf8');
    expect(await repairClaudeGlobalConfig({ homeDir: home })).toBe('unrepairable');
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(truncated);
  });

  it('runs from prepareClaudeWorkspaceContext even for in-place workspaces', async () => {
    const valid = '{ "numStartups": 1 }';
    fs.writeFileSync(cfg(), `${valid}LEFTOVER`, 'utf8');
    const cwd = path.join(home, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    // workspaceCwd === worktreeCwd → the context-linking work early-returns,
    // but the config self-heal must still have happened.
    await prepareClaudeWorkspaceContext(cwd, cwd, { homeDir: home });
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(valid);
  });
});

describe('claudeSlugForCwd', () => {
  it('mirrors the Claude CLI convention of replacing path separators', () => {
    expect(claudeSlugForCwd('/Users/dev/projects/SigmaLink/app')).toBe(
      '-Users-dev-projects-SigmaLink-app',
    );
  });

  // SF-2 (v1.29.0) regression — the Claude CLI replaces EVERY non-alphanumeric
  // character with `-`, not only `/`. These cases are pinned against the real
  // claude 2.1.150 on-disk layout (verified empirically; see jsonl-bridge
  // header comment). A previous implementation only replaced `/`, so any cwd
  // with a space/dot/paren produced a slug that did NOT match the directory
  // Claude reads — the bridge symlinked the resume JSONL into the wrong dir and
  // `claude --resume <id>` reported "No conversation found with session ID".
  it('replaces spaces with - (macOS userData "Application Support" path)', () => {
    expect(
      claudeSlugForCwd('/Users/me/Library/Application Support/SigmaLink/app'),
    ).toBe('-Users-me-Library-Application-Support-SigmaLink-app');
  });

  it('replaces dots with -', () => {
    expect(claudeSlugForCwd('/tmp/a.b')).toBe('-tmp-a-b');
  });

  it('replaces parentheses with -', () => {
    expect(claudeSlugForCwd('/tmp/a(b)c')).toBe('-tmp-a-b-c');
  });

  it('does NOT collapse consecutive separators (1:1 replacement)', () => {
    // claude: /tmp/a..b -> -private-tmp-a--b (two dots → two dashes)
    expect(claudeSlugForCwd('/tmp/a..b')).toBe('-tmp-a--b');
  });

  it('preserves case and digits', () => {
    expect(claudeSlugForCwd('/tmp/CaseKept123')).toBe('-tmp-CaseKept123');
  });

  it('produces matching slugs for the SF-2 workspace + worktree-with-space pair', () => {
    // The operator repro: a worktree cwd containing a space (and/or a dot).
    // Under the old `/`-only rule the bridge target slug diverged from the slug
    // Claude derives from the same cwd. With the correct rule they are equal
    // — which is exactly what makes the bridged symlink discoverable.
    const worktreeCwd =
      '/Users/aisigma/Library/Application Support/SigmaLink/worktrees/abc.123/pane-0/app';
    expect(claudeSlugForCwd(worktreeCwd)).toBe(
      '-Users-aisigma-Library-Application-Support-SigmaLink-worktrees-abc-123-pane-0-app',
    );
    // No raw space, dot, or slash may survive in the slug.
    expect(claudeSlugForCwd(worktreeCwd)).not.toMatch(/[^a-zA-Z0-9-]/);
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

  it('returns "missing" for an in-place workspace when the conversation JSONL is absent', async () => {
    // Issue A regression: an in-place workspace (workspaceCwd === worktreeCwd)
    // whose conversation was deleted/aged out must report 'missing' so the
    // caller falls back to `--continue` instead of `claude --resume <ghost-id>`
    // (which prints "No conversation found with session ID …" and drops to a
    // shell). Previously this returned 'skipped' unconditionally → ghost resume.
    const cwd = '/tmp/ws-inplace-missing';
    // NOTE: no seedSourceJsonl — the JSONL does not exist on disk.
    const outcome = await prepareClaudeResume(cwd, cwd, VALID_UUID, { homeDir });
    expect(outcome).toBe('missing');
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
