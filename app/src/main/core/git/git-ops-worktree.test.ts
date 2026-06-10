// Real-git integration tests for ensureWorktree — the Part B fix for the
// force-quit resume bug (a worktree dir goes missing on disk while its
// agent_sessions row still records the path).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCmd } from '../../lib/exec';
import { ensureWorktree, gitArgsWithLongPaths } from './git-ops';

describe('ensureWorktree (force-quit resume recovery)', () => {
  let repo: string;
  let wt: string;
  const branch = 'sigmalink/claude/pane-0-deadbeef';

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ensure-wt-'));
    await execCmd('git', ['init'], { cwd: repo });
    await execCmd('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    await execCmd('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    await execCmd('git', ['add', '-A'], { cwd: repo });
    await execCmd('git', ['commit', '-m', 'init'], { cwd: repo });
    wt = path.join(repo, '.worktrees', 'pane-0');
    const add = await execCmd('git', ['worktree', 'add', '-b', branch, wt, 'HEAD'], { cwd: repo });
    expect(add.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('is a no-op when the worktree directory still exists', async () => {
    const r = await ensureWorktree({ repoRoot: repo, worktreePath: wt, branch });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('recreates a worktree whose directory was deleted, re-attaching the existing branch', async () => {
    // Simulate force-quit + the dir vanishing (manual delete / external removal /
    // older-release cleanup) while the branch + stale admin entry remain.
    fs.rmSync(wt, { recursive: true, force: true });
    expect(fs.existsSync(wt)).toBe(false);

    const r = await ensureWorktree({ repoRoot: repo, worktreePath: wt, branch });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(true);
    // A real checkout of the branch → the committed file is present.
    expect(fs.existsSync(path.join(wt, 'README.md'))).toBe(true);
  });

  it('returns ok:false (never throws) when no branch is recorded for a missing dir', async () => {
    fs.rmSync(wt, { recursive: true, force: true });
    const r = await ensureWorktree({ repoRoot: repo, worktreePath: wt, branch: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('gitArgsWithLongPaths (win32 MAX_PATH)', () => {
  it('win32: prepends -c core.longpaths=true before the subcommand', () => {
    expect(gitArgsWithLongPaths(['worktree', 'add', '-b', 'b', '/p', 'HEAD'], 'win32')).toEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      '-b',
      'b',
      '/p',
      'HEAD',
    ]);
  });

  it('darwin/linux: returns the base argv unchanged (same reference — zero churn)', () => {
    const base = ['worktree', 'add', '/p', 'branch'];
    expect(gitArgsWithLongPaths(base, 'darwin')).toBe(base);
    expect(gitArgsWithLongPaths(base, 'linux')).toBe(base);
  });
});
