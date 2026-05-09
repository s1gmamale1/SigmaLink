// Pure-function Git helpers built on argument-array exec (no shell interpolation).

import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execCmd } from '../../lib/exec';
import type { GitDiff, GitStatus } from '../../../shared/types';

export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const res = await execCmd('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeoutMs: 5_000,
    });
    if (res.code !== 0) return null;
    const top = res.stdout.trim();
    return top.length ? path.normalize(top) : null;
  } catch {
    return null;
  }
}

export function repoHash(repoRoot: string): string {
  return createHash('sha1').update(path.normalize(repoRoot)).digest('hex').slice(0, 12);
}

export function sanitizeBranchSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._\/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
  return cleaned.slice(0, 80) || 'agent-session';
}

export function generateBranchName(role: string, hint?: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  const base = sanitizeBranchSegment(`${role}/${hint ?? 'task'}-${suffix}`);
  return `sigmalink/${base}`;
}

export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  if (!fs.existsSync(cwd)) return null;
  const root = await getRepoRoot(cwd);
  if (!root) return null;

  const [branchRes, statusRes, aheadBehindRes] = await Promise.all([
    execCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5_000 }),
    execCmd('git', ['status', '--porcelain=v1', '-uall'], { cwd, timeoutMs: 8_000 }),
    execCmd('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], {
      cwd,
      timeoutMs: 5_000,
    }),
  ]);

  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : 'HEAD';
  const lines = statusRes.code === 0 ? statusRes.stdout.split(/\r?\n/).filter(Boolean) : [];
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (x === '?' && y === '?') untracked.push(file);
    else {
      if (x !== ' ' && x !== '?') staged.push(file);
      if (y !== ' ' && y !== '?') unstaged.push(file);
    }
  }

  let ahead = 0;
  let behind = 0;
  if (aheadBehindRes.code === 0) {
    const parts = aheadBehindRes.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = Number(parts[0]) || 0;
      ahead = Number(parts[1]) || 0;
    }
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    clean: !staged.length && !unstaged.length && !untracked.length,
  };
}

export async function gitDiff(cwd: string): Promise<GitDiff | null> {
  if (!fs.existsSync(cwd)) return null;
  const root = await getRepoRoot(cwd);
  if (!root) return null;
  const [statRes, patchesRes, untrackedRes] = await Promise.all([
    execCmd('git', ['diff', '--stat', 'HEAD'], { cwd, timeoutMs: 8_000 }),
    execCmd('git', ['diff', 'HEAD'], { cwd, timeoutMs: 15_000, maxBuffer: 16 * 1024 * 1024 }),
    execCmd('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeoutMs: 5_000 }),
  ]);
  return {
    stat: statRes.stdout,
    patches: patchesRes.stdout,
    untrackedFiles: untrackedRes.stdout.split(/\r?\n/).filter(Boolean),
  };
}

export async function runShellLine(
  cwd: string,
  line: string,
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Best-effort tokenizer: split on whitespace except inside double-quotes.
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  if (tokens.length === 0) return { stdout: '', stderr: 'empty command', code: -1 };
  const [cmd, ...args] = tokens;
  const res = await execCmd(cmd, args, { cwd, timeoutMs });
  return { stdout: res.stdout, stderr: res.stderr, code: res.code };
}

export async function commitAndMerge(input: {
  worktreePath: string;
  branch: string;
  repoRoot: string;
  message: string;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  const log: string[] = [];
  const stderr: string[] = [];

  const add = await execCmd('git', ['add', '-A'], { cwd: input.worktreePath, timeoutMs: 30_000 });
  log.push(add.stdout);
  stderr.push(add.stderr);
  if (add.code !== 0) return { stdout: log.join(''), stderr: stderr.join(''), code: add.code };

  const cached = await execCmd('git', ['diff', '--cached', '--quiet'], {
    cwd: input.worktreePath,
    timeoutMs: 10_000,
  });
  // exit 0 = clean, exit 1 = staged changes, anything else = error.
  if (cached.code === 1) {
    const commit = await execCmd('git', ['commit', '-m', input.message], {
      cwd: input.worktreePath,
      timeoutMs: 30_000,
    });
    log.push(commit.stdout);
    stderr.push(commit.stderr);
    if (commit.code !== 0) {
      return { stdout: log.join(''), stderr: stderr.join(''), code: commit.code };
    }
  } else if (cached.code !== 0) {
    return {
      stdout: log.join(''),
      stderr: stderr.join('') + cached.stderr,
      code: cached.code,
    };
  }

  const merge = await execCmd('git', ['merge', '--no-ff', input.branch], {
    cwd: input.repoRoot,
    timeoutMs: 60_000,
  });
  log.push(merge.stdout);
  stderr.push(merge.stderr);
  return { stdout: log.join(''), stderr: stderr.join(''), code: merge.code };
}

export async function worktreeAdd(args: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  base: string;
}): Promise<void> {
  const res = await execCmd(
    'git',
    ['worktree', 'add', '-b', args.branch, args.worktreePath, args.base],
    { cwd: args.repoRoot, timeoutMs: 30_000 },
  );
  if (res.code !== 0) {
    throw new Error(`git worktree add failed: ${res.stderr || res.stdout}`);
  }
}

export async function worktreeRemove(repoRoot: string, worktreePath: string): Promise<void> {
  await execCmd('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  await execCmd('git', ['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 10_000 });
}
