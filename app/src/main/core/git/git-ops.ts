// Pure-function Git helpers built on argument-array exec (no shell interpolation).
//
// Tokenizer (`tokenizeShellLine`) examples:
//   git commit -m "It's working"     -> ['git','commit','-m',"It's working"]
//   echo 'hi' "there"                -> ['echo','hi','there']
//   path "C:\\Users\\me"             -> ['path','C:\\Users\\me']
//   path "C:\\Users\\\"me\""         -> ['path','C:\\Users\\"me"']
//   echo  ""                         -> ['echo','']            (empty quoted segment is preserved)

import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execCmd } from '../../lib/exec';
import { resolveWindowsCommand } from '../pty/local-pty';
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
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
  return cleaned.slice(0, 80) || 'agent-session';
}

export function generateBranchName(role: string, hint?: string): string {
  // 8 base-36 chars (~2.8e12 states) keeps collision probability astronomical
  // even when hundreds of panes share the same role+hint. Using randomUUID()
  // also avoids dependence on Math.random() entropy quality.
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
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

/**
 * Shell-style tokenizer for `runShellLine`. Handles:
 *  - whitespace as a token boundary
 *  - single-quoted segments (no escapes inside)
 *  - double-quoted segments (backslash escapes \", \\, \n, \r, \t, \$, \`)
 *  - empty quoted segments preserved as ''
 *  - adjacent quoted/unquoted segments concatenate into one token
 *    (e.g. `a"b c"d` -> `ab cd`)
 *
 * This is intentionally small and dependency-free; it covers the cases the
 * launcher currently exposes (git plumbing) and gracefully handles user-typed
 * paths with spaces/quotes.
 */
export function tokenizeShellLine(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  type State = 'NORMAL' | 'SQ' | 'DQ';
  let state: State = 'NORMAL';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (state === 'NORMAL') {
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        if (inToken) {
          tokens.push(cur);
          cur = '';
          inToken = false;
        }
        i++;
        continue;
      }
      if (ch === "'") {
        state = 'SQ';
        inToken = true;
        i++;
        continue;
      }
      if (ch === '"') {
        state = 'DQ';
        inToken = true;
        i++;
        continue;
      }
      cur += ch;
      inToken = true;
      i++;
      continue;
    }
    if (state === 'SQ') {
      if (ch === "'") {
        state = 'NORMAL';
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    // DQ
    if (ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1];
      // Only a small subset of escapes are recognised inside double quotes.
      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        cur += next;
        i += 2;
        continue;
      }
      if (next === 'n') {
        cur += '\n';
        i += 2;
        continue;
      }
      if (next === 'r') {
        cur += '\r';
        i += 2;
        continue;
      }
      if (next === 't') {
        cur += '\t';
        i += 2;
        continue;
      }
      // Unknown escape: keep the backslash literal (POSIX-ish behaviour).
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      state = 'NORMAL';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

export async function runShellLine(
  cwd: string,
  line: string,
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const tokens = tokenizeShellLine(line);
  if (tokens.length === 0) return { stdout: '', stderr: 'empty command', code: -1 };
  let [cmd, ...args] = tokens;
  // On Windows, resolve PATH+PATHEXT for extensionless commands so npm-installed
  // CLIs (`.cmd` shims) can be found by the argument-array spawn (which does
  // NOT honour PATHEXT). `.cmd`/`.bat` shims are routed through `cmd.exe`.
  if (process.platform === 'win32') {
    const resolved = resolveWindowsCommand(cmd) ?? cmd;
    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      args = ['/d', '/s', '/c', resolved, ...args];
      cmd = 'cmd.exe';
    } else if (ext === '.ps1') {
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args];
      cmd = 'powershell.exe';
    } else {
      cmd = resolved;
    }
  }
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

export async function worktreePruneRepo(repoRoot: string): Promise<void> {
  try {
    await execCmd('git', ['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 10_000 });
  } catch {
    /* best-effort */
  }
}
