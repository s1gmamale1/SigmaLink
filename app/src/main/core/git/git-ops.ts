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
import { canonicalPathKey } from '../util/path-key';
import { buildWindowsSpawnArgs } from '../util/windows-spawn';
import type {
  GitActivityBucket,
  GitBranchList,
  GitDiff,
  GitLogEntry,
  GitStatus,
  GitStatusSummary,
} from '../../../shared/types';

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
  return createHash('sha1').update(canonicalPathKey(repoRoot)).digest('hex').slice(0, 12);
}

export function sanitizeBranchSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
  return cleaned.slice(0, 80) || 'agent-session';
}

export function generateBranchName(role: string, hint?: string, sessionId?: string): string {
  // When a pre-allocated session UUID is provided, derive the 8-char suffix
  // from it (strip dashes, take first 8 hex chars) so the worktree path
  // encodes the same UUID that will be stored in agent_sessions.id — making
  // the filesystem self-documenting. Without a sessionId we fall back to a
  // fresh randomUUID() to preserve backward-compatibility for callers that
  // haven't been updated to pre-allocate.
  const suffix = sessionId
    ? sessionId.replace(/-/g, '').slice(0, 8)
    : randomUUID().replace(/-/g, '').slice(0, 8);
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

/**
 * perf-hot-paths Task 3 — count-only status for the pane-header badge. ONE
 * git proc (`status --porcelain`) instead of gitStatus's four (rev-parse
 * --show-toplevel, rev-parse --abbrev-ref, status, rev-list), and a 2-field
 * payload instead of full staged/unstaged/untracked filename arrays.
 * `git status` exits non-zero outside a work tree, so the repo probe is
 * folded in for free. Count parity with useUncommittedCount's historical
 * `staged.length + unstaged.length + untracked.length` is preserved exactly
 * (an 'MM' line increments both staged AND unstaged).
 */
export async function gitStatusSummary(cwd: string): Promise<GitStatusSummary | null> {
  if (!fs.existsSync(cwd)) return null;
  const res = await execCmd('git', ['status', '--porcelain=v1', '-uall'], {
    cwd,
    timeoutMs: 8_000,
  });
  if (res.code !== 0) return null; // not a git work tree (or git unavailable)

  let uncommitted = 0;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      uncommitted += 1;
      continue;
    }
    if (x !== ' ' && x !== '?') uncommitted += 1;
    if (y !== ' ' && y !== '?') uncommitted += 1;
  }
  return { uncommitted, clean: uncommitted === 0 };
}

export async function gitDiff(cwd: string): Promise<GitDiff | null> {
  if (!fs.existsSync(cwd)) return null;
  const root = await getRepoRoot(cwd);
  if (!root) return null;
  const DIFF_MAX_BUFFER = 16 * 1024 * 1024;
  const [statRes, patchesRes, untrackedRes] = await Promise.all([
    execCmd('git', ['diff', '--stat', 'HEAD'], { cwd, timeoutMs: 8_000 }),
    execCmd('git', ['diff', 'HEAD'], { cwd, timeoutMs: 15_000, maxBuffer: DIFF_MAX_BUFFER }),
    execCmd('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeoutMs: 5_000 }),
  ]);
  // `execCmd` signals truncation via `maxBufferExceeded` rather than throwing.
  // We also check whether the output byte-length is suspiciously close to the
  // cap (within 1 byte) as a belt-and-suspenders guard.
  const truncated =
    patchesRes.maxBufferExceeded ||
    Buffer.byteLength(patchesRes.stdout, 'utf8') >= DIFF_MAX_BUFFER - 1;
  return {
    stat: statRes.stdout,
    patches: patchesRes.stdout,
    untrackedFiles: untrackedRes.stdout.split(/\r?\n/).filter(Boolean),
    truncated,
  };
}

/**
 * BSP-G2 — staged-only diff (`git diff --cached --no-color`).
 * Returns the same `GitDiff` shape as `gitDiff`; only the patches source changes.
 */
export async function gitDiffStaged(cwd: string): Promise<GitDiff | null> {
  if (!fs.existsSync(cwd)) return null;
  const root = await getRepoRoot(cwd);
  if (!root) return null;
  const DIFF_MAX_BUFFER = 16 * 1024 * 1024;
  const [statRes, patchesRes] = await Promise.all([
    execCmd('git', ['diff', '--cached', '--stat'], { cwd, timeoutMs: 8_000 }),
    execCmd('git', ['diff', '--cached', '--no-color'], {
      cwd,
      timeoutMs: 15_000,
      maxBuffer: DIFF_MAX_BUFFER,
    }),
  ]);
  const truncated =
    patchesRes.maxBufferExceeded ||
    Buffer.byteLength(patchesRes.stdout, 'utf8') >= DIFF_MAX_BUFFER - 1;
  return {
    stat: statRes.stdout,
    patches: patchesRes.stdout,
    untrackedFiles: [],
    truncated,
  };
}

/**
 * BSP-G2 — unstaged diff (`git diff --no-color`, excludes staged hunks).
 * Returns the same `GitDiff` shape as `gitDiff`.
 */
export async function gitDiffUnstaged(cwd: string): Promise<GitDiff | null> {
  if (!fs.existsSync(cwd)) return null;
  const root = await getRepoRoot(cwd);
  if (!root) return null;
  const DIFF_MAX_BUFFER = 16 * 1024 * 1024;
  const [statRes, patchesRes] = await Promise.all([
    execCmd('git', ['diff', '--stat'], { cwd, timeoutMs: 8_000 }),
    execCmd('git', ['diff', '--no-color'], {
      cwd,
      timeoutMs: 15_000,
      maxBuffer: DIFF_MAX_BUFFER,
    }),
  ]);
  const truncated =
    patchesRes.maxBufferExceeded ||
    Buffer.byteLength(patchesRes.stdout, 'utf8') >= DIFF_MAX_BUFFER - 1;
  return {
    stat: statRes.stdout,
    patches: patchesRes.stdout,
    untrackedFiles: [],
    truncated,
  };
}

const GIT_LOG_LIMIT_MAX = 500;

/**
 * BSP-G2 — commit log for the Git History panel.
 * Returns up to `limit` entries (capped at 500) via NUL-delimited `--pretty=format`.
 */
export async function gitLog(cwd: string, limit = 100): Promise<GitLogEntry[]> {
  if (!fs.existsSync(cwd)) return [];
  const root = await getRepoRoot(cwd);
  if (!root) return [];
  const bounded = Math.min(Math.max(1, Math.floor(limit)), GIT_LOG_LIMIT_MAX);
  // NUL (0x00) as field delimiter so subjects with unusual chars parse safely.
  const fmt = '%H%x00%h%x00%s%x00%an%x00%ar%x00%D';
  const res = await execCmd(
    'git',
    ['log', `--pretty=format:${fmt}`, `-n`, String(bounded)],
    { cwd, timeoutMs: 10_000 },
  );
  if (res.code !== 0 || !res.stdout.trim()) return [];
  const entries: GitLogEntry[] = [];
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\x00');
    if (parts.length < 6) continue;
    entries.push({
      sha: parts[0],
      shortSha: parts[1],
      subject: parts[2],
      author: parts[3],
      relDate: parts[4],
      refs: parts[5],
    });
  }
  return entries;
}

/**
 * BSP-G2 — branch list for the Git Branches panel.
 * Uses `git branch --list --format=...` with NUL delimiters to enumerate all local branches.
 */
export async function listBranches(cwd: string): Promise<GitBranchList> {
  const empty: GitBranchList = { current: '', branches: [] };
  if (!fs.existsSync(cwd)) return empty;
  const root = await getRepoRoot(cwd);
  if (!root) return empty;

  // Format: `*<current>` flag + branch name + optional upstream ref.
  // %(HEAD) = '*' if current, ' ' otherwise. %(upstream:short) may be empty.
  const fmt = '%(HEAD)%x00%(refname:short)%x00%(upstream:short)';
  const res = await execCmd(
    'git',
    ['branch', '--list', `--format=${fmt}`],
    { cwd, timeoutMs: 8_000 },
  );
  if (res.code !== 0) return empty;

  let current = '';
  const branches: GitBranchList['branches'] = [];

  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\x00');
    if (parts.length < 2) continue;
    const isCurrent = parts[0] === '*';
    const name = parts[1].trim();
    const upstream = parts[2]?.trim() || undefined;
    if (!name) continue;
    if (isCurrent) current = name;
    branches.push({ name, current: isCurrent, upstream });
  }

  return { current, branches };
}

/** Validate a branch name for `switchBranch`: no leading `-`, no shell metachars. */
function isValidBranchName(branch: string): boolean {
  if (!branch || branch.startsWith('-')) return false;
  // Disallow shell metacharacters and path-traversal sequences.
  if (/[\s;&|<>()$`\\'"!{}[\]*?#~^]/.test(branch)) return false;
  if (branch.includes('..')) return false;
  return true;
}

/**
 * BSP-G2 — switch to a local branch.
 * Refuses when the working tree is dirty (staged, unstaged, or untracked files).
 * Validates the branch name to prevent argument injection.
 */
export async function switchBranch(
  cwd: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isValidBranchName(branch)) {
    return { ok: false, error: 'invalid branch name' };
  }
  if (!fs.existsSync(cwd)) return { ok: false, error: 'path not found' };
  const status = await gitStatus(cwd);
  if (!status) return { ok: false, error: 'not a git repository' };
  if (!status.clean) return { ok: false, error: 'working tree dirty' };

  const res = await execCmd('git', ['switch', branch], { cwd, timeoutMs: 15_000 });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || 'git switch failed' };
  }
  return { ok: true };
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
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32') {
    const resolved = buildWindowsSpawnArgs(cmd, args);
    cmd = resolved.command;
    args = resolved.args;
    windowsVerbatimArguments = resolved.windowsVerbatimArguments ?? false;
  }
  const res = await execCmd(cmd, args, { cwd, timeoutMs, windowsVerbatimArguments });
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
  if (merge.code !== 0) {
    // A failed `git merge --no-ff` (most commonly a conflict, exit 1) leaves
    // repoRoot with MERGE_HEAD set and the base branch in a half-merged,
    // conflicted state. Abort so the base branch is restored to its pre-merge
    // HEAD and is safe for the next operation. Best-effort: `merge --abort`
    // is a no-op (non-zero, harmless) when there was no merge in progress.
    const abort = await execCmd('git', ['merge', '--abort'], {
      cwd: input.repoRoot,
      timeoutMs: 30_000,
    });
    log.push(abort.stdout);
    stderr.push(abort.stderr);
  }
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

/**
 * Recreate a git worktree whose directory has gone missing on disk — e.g. it
 * was deleted while the app was closed, removed with an external
 * `git worktree remove`, or reaped by an older release's cleanup. Used by the
 * resume path so a pane never spawns into a non-existent cwd (which silently
 * lands the CLI in the user's home dir and resumes the wrong project context —
 * the "black/error pane after force-quit" report).
 *
 * No-op when the directory already exists. Otherwise it prunes any stale
 * worktree admin entry git still holds for the path, then re-attaches the
 * EXISTING branch there (no `-b`). If the branch is gone (merged/deleted) it
 * creates a fresh branch at HEAD as a last resort. Returns `{ ok: false }`
 * (never throws) so the caller can fall back to a valid cwd.
 */
export async function ensureWorktree(args: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (fs.existsSync(args.worktreePath)) return { ok: true };
  if (!args.branch) return { ok: false, error: 'no branch recorded for worktree' };
  // Clear any stale admin entry for the now-missing path so the re-add below
  // does not fail with "already registered".
  await worktreePruneRepo(args.repoRoot);
  try {
    fs.mkdirSync(path.dirname(args.worktreePath), { recursive: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Re-attach the EXISTING branch at the path (no `-b`).
  let res = await execCmd(
    'git',
    ['worktree', 'add', args.worktreePath, args.branch],
    { cwd: args.repoRoot, timeoutMs: 30_000 },
  );
  if (res.code !== 0) {
    // Branch may have been deleted/merged away — recreate it fresh at HEAD.
    res = await execCmd(
      'git',
      ['worktree', 'add', '-b', args.branch, args.worktreePath, 'HEAD'],
      { cwd: args.repoRoot, timeoutMs: 30_000 },
    );
  }
  return res.code === 0
    ? { ok: true }
    : { ok: false, error: res.stderr || res.stdout };
}

export async function worktreeRemove(repoRoot: string, worktreePath: string): Promise<void> {
  const remove = await execCmd('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  if (remove.code !== 0) {
    throw new Error(`git worktree remove failed: ${remove.stderr || remove.stdout}`);
  }
  const prune = await execCmd('git', ['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 10_000 });
  if (prune.code !== 0) {
    throw new Error(`git worktree prune failed: ${prune.stderr || prune.stdout}`);
  }
}

export async function worktreePruneRepo(repoRoot: string): Promise<void> {
  try {
    await execCmd('git', ['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 10_000 });
  } catch {
    /* best-effort */
  }
}

/**
 * Predict files that would conflict if `branch` were merged onto `base` in
 * `repoRoot`. Uses `git merge-tree --write-tree` (Git 2.38+); on older Git or
 * when the call fails for any reason, falls back to a name-only intersection
 * heuristic that flags every file changed on both sides since their merge base.
 */
export async function mergePreview(
  repoRoot: string,
  base: string,
  branch: string,
): Promise<{ conflicts: string[]; method: 'merge-tree' | 'heuristic' | 'unavailable' }> {
  try {
    const res = await execCmd(
      'git',
      ['merge-tree', '--write-tree', '--name-only', '--merge-base=' + base, base, branch],
      { cwd: repoRoot, timeoutMs: 15_000 },
    );
    // Modern git: prints the resulting tree id on the first line, then a blank
    // line, then a list of conflicted paths (one per line). Exit code 1 means
    // conflicts present, 0 means clean.
    if (res.code === 0) return { conflicts: [], method: 'merge-tree' };
    if (res.code === 1) {
      const lines = res.stdout.split(/\r?\n/);
      // Drop tree id (line 0) and blank separators.
      const conflicts: string[] = [];
      let started = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (i === 0 && line.length === 40) continue; // tree id
        if (!started && line === '') {
          started = true;
          continue;
        }
        if (line.length === 0) continue;
        // Skip OID/mode prefixed lines (some git versions print them)
        if (/^[0-9a-f]{40}\s/.test(line) || /^\d{6}\s/.test(line)) continue;
        conflicts.push(line);
      }
      // De-duplicate while preserving insertion order.
      const seen = new Set<string>();
      const uniq = conflicts.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
      return { conflicts: uniq, method: 'merge-tree' };
    }
    // Unknown error code → fall through to heuristic.
  } catch {
    /* fallthrough */
  }
  // Heuristic fallback for older git versions: compute names changed on each
  // side of the merge base and intersect them. False positives are possible
  // (two-way edit of unrelated lines in same file) but it's safe — the
  // operator still sees the actual `git merge` outcome at commit time.
  try {
    const baseRes = await execCmd('git', ['merge-base', base, branch], {
      cwd: repoRoot,
      timeoutMs: 5_000,
    });
    if (baseRes.code !== 0) {
      return { conflicts: [], method: 'unavailable' };
    }
    const mergeBase = baseRes.stdout.trim();
    const [leftRes, rightRes] = await Promise.all([
      execCmd('git', ['diff', '--name-only', `${mergeBase}..${base}`], {
        cwd: repoRoot,
        timeoutMs: 8_000,
      }),
      execCmd('git', ['diff', '--name-only', `${mergeBase}..${branch}`], {
        cwd: repoRoot,
        timeoutMs: 8_000,
      }),
    ]);
    const left = new Set(leftRes.stdout.split(/\r?\n/).filter(Boolean));
    const right = rightRes.stdout.split(/\r?\n/).filter(Boolean);
    const conflicts = right.filter((p) => left.has(p));
    return { conflicts, method: 'heuristic' };
  } catch {
    return { conflicts: [], method: 'unavailable' };
  }
}

/**
 * P6 FEAT-11 — agent undo/rewind. Create a checkpoint: a commit that captures
 * the worktree's current WIP as a reversible savepoint on the pane's own
 * throwaway branch. `commitAndMerge` merges that branch with `--no-ff`, so
 * checkpoint commits DO enter the merged history (review NIT-2) — harmless to
 * correctness (final tree is right, conflicts still abort cleanly), just noise.
 *
 * Implementation:
 *   1. `fs.existsSync` guard (worktree may have been pruned).
 *   2. `git add -A`            — stage every change incl. new files.
 *   3. `git commit --allow-empty --no-verify -m "sigmalink checkpoint: <label>"`
 *      — `--allow-empty` so a checkpoint can be taken even with no pending
 *        change (the savepoint is still a valid restore target); `--no-verify`
 *        so a slow/broken pre-commit hook in the target repo can't block the
 *        savepoint.
 *   4. `git rev-parse HEAD`    — return the new commit's sha.
 */
export async function createCheckpoint(
  worktreePath: string,
  label?: string,
): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, error: 'worktree path missing' };
  }
  const message = `sigmalink checkpoint: ${label && label.trim() ? label.trim() : new Date().toISOString()}`;

  const add = await execCmd('git', ['add', '-A'], { cwd: worktreePath, timeoutMs: 30_000 });
  if (add.code !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr || add.stdout}` };
  }

  const commit = await execCmd(
    'git',
    ['commit', '--allow-empty', '--no-verify', '-m', message],
    { cwd: worktreePath, timeoutMs: 30_000 },
  );
  if (commit.code !== 0) {
    return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }

  const rev = await execCmd('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    timeoutMs: 5_000,
  });
  if (rev.code !== 0) {
    return { ok: false, error: `git rev-parse failed: ${rev.stderr || rev.stdout}` };
  }
  return { ok: true, sha: rev.stdout.trim() };
}

/**
 * P6 FEAT-11 — restore a worktree to a previous checkpoint. This is the
 * DESTRUCTIVE half: `git reset --hard <sha>` discards every commit + working
 * change after the target. Two safeguards make it bounded and reversible:
 *
 *   - VALIDATION (before anything mutates): the sha must be a real commit in
 *     THIS worktree AND on its linear history. `git cat-file -e <sha>^{commit}`
 *     proves it's a commit object that exists; `git merge-base --is-ancestor`
 *     (checked in BOTH directions) proves it lies on this branch's history —
 *     an ancestor of HEAD (rewind) or a descendant (redo, to undo a prior
 *     rewind) — rejecting only an arbitrary / foreign / divergent sha.
 *   - SAFETY-FIRST: BEFORE the reset we take an auto "pre-rewind" checkpoint of
 *     the CURRENT state and return its sha. So even the rewind is undoable —
 *     restoring that safety sha (a descendant of the rewound HEAD) gets the
 *     discarded work back. ORDER MATTERS: the snapshot is committed before the
 *     destructive reset.
 */
export async function restoreCheckpoint(
  worktreePath: string,
  sha: string,
): Promise<{ ok: boolean; safetySha?: string; error?: string }> {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, error: 'worktree path missing' };
  }
  // 0) Hard sha-format guard (review NIT-1) — defends the `reset --hard <sha>`
  //    argv against a `-`-prefixed value being parsed as a flag, even if a
  //    future non-`rev-parse` insert path ever feeds the checkpoint table.
  if (!/^[0-9a-f]{7,64}$/.test(sha)) {
    return { ok: false, error: 'invalid checkpoint sha' };
  }

  // 1) Validate the sha is a real commit object in this worktree.
  const exists = await execCmd('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: worktreePath,
    timeoutMs: 5_000,
  });
  if (exists.code !== 0) {
    return { ok: false, error: 'checkpoint commit not found in this worktree' };
  }
  // 2) Validate the sha lies on THIS worktree's linear history — in EITHER
  //    direction: an ancestor of HEAD (a rewind) OR a descendant of HEAD (a
  //    redo — restoring the auto "pre-rewind" safety checkpoint to undo a
  //    previous rewind and recover the discarded work). Both are `git reset
  //    --hard <sha>` and equally safe mechanically; only a truly divergent /
  //    foreign sha (neither ancestor nor descendant) is rejected. (The
  //    controller's ownership guard already proves the sha is one of THIS
  //    session's recorded checkpoints; this is the standalone git-layer net.)
  const isAncestor = await execCmd('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
    cwd: worktreePath,
    timeoutMs: 5_000,
  });
  // Short-circuit the descendant probe when it's already an ancestor.
  const isDescendant =
    isAncestor.code === 0
      ? { code: 1 }
      : await execCmd('git', ['merge-base', '--is-ancestor', 'HEAD', sha], {
          cwd: worktreePath,
          timeoutMs: 5_000,
        });
  if (isAncestor.code !== 0 && isDescendant.code !== 0) {
    return {
      ok: false,
      error: 'checkpoint is not on this worktree history (neither an ancestor nor a descendant of the current state)',
    };
  }

  // 3) Safety snapshot of the CURRENT state BEFORE the destructive reset, so the
  //    rewind itself is undoable.
  const safety = await createCheckpoint(worktreePath, 'pre-rewind');
  if (!safety.ok) {
    return { ok: false, error: `pre-rewind safety checkpoint failed: ${safety.error ?? 'unknown'}` };
  }

  // 4) Now the destructive reset.
  const reset = await execCmd('git', ['reset', '--hard', sha], {
    cwd: worktreePath,
    timeoutMs: 30_000,
  });
  if (reset.code !== 0) {
    // The safety checkpoint is already committed, so the current state is
    // recoverable even though the reset failed.
    return {
      ok: false,
      safetySha: safety.sha,
      error: `git reset failed: ${reset.stderr || reset.stdout}`,
    };
  }
  return { ok: true, safetySha: safety.sha };
}

/**
 * Discard every uncommitted change in a worktree: revert tracked files to
 * HEAD, drop staged additions, and remove untracked / ignored files. Best
 * effort; logs are returned for the operator.
 */
export async function dropChanges(
  worktreePath: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!fs.existsSync(worktreePath)) {
    return { stdout: '', stderr: 'worktree path missing', code: -1 };
  }
  const out: string[] = [];
  const err: string[] = [];
  // 1) restore tracked
  const r1 = await execCmd(
    'git',
    ['restore', '--worktree', '--staged', '--source', 'HEAD', '--', '.'],
    { cwd: worktreePath, timeoutMs: 30_000 },
  );
  out.push(r1.stdout);
  err.push(r1.stderr);
  // 2) clean untracked + ignored
  const r2 = await execCmd('git', ['clean', '-fd'], {
    cwd: worktreePath,
    timeoutMs: 30_000,
  });
  out.push(r2.stdout);
  err.push(r2.stderr);
  return {
    stdout: out.join(''),
    stderr: err.join(''),
    code: r1.code === 0 && r2.code === 0 ? 0 : r1.code || r2.code,
  };
}

// ── P6 FEAT-8 — per-worktree git-activity heatmap ──────────────────────────
// Returns one bucket per local calendar day (oldest→newest) for the last
// `days` of the worktree's checked-out branch history. Foundation skeleton;
// the FEAT-8 lane implements via `git log --numstat --since`.
//
// Callers MUST contain `cwd` (assertAllowedPath) before invoking — git log
// traverses commit history and must only run inside allowed workspace roots.
export async function gitActivityLog(
  cwd: string,
  days = 30,
): Promise<GitActivityBucket[]> {
  if (!fs.existsSync(cwd)) return [];
  try {
    const root = await getRepoRoot(cwd);
    if (!root) return [];

    // `--date=unix` makes %at the author epoch; we convert to the OPERATOR's
    // local calendar day (not UTC) so a commit at 11pm local lands on the right
    // bucket. `--no-merges` skips merge commits (their numstat is noisy/empty),
    // `-n 500` caps traversal cost. We emit one `COMMIT <sha> <epoch>` marker
    // line per commit, then `git`'s numstat lines (`add\tdel\tpath`) follow.
    const sinceArg = `--since=${Math.max(1, Math.floor(days))}.days.ago`;
    const res = await execCmd(
      'git',
      [
        'log',
        '--no-merges',
        sinceArg,
        '--numstat',
        '--date=unix',
        '--pretty=format:COMMIT %H %at',
        '-n',
        '500',
      ],
      { cwd, timeoutMs: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (res.code !== 0) return [];

    // Accumulate per local-day. A commit's day is fixed by its marker line;
    // every numstat line until the next marker belongs to that commit's day.
    interface DayAccum {
      commitCount: number;
      filesChanged: number;
      linesAdded: number;
      linesDeleted: number;
    }
    const byDay = new Map<string, DayAccum>();
    let currentDay: string | null = null;

    const ensureDay = (day: string): DayAccum => {
      let acc = byDay.get(day);
      if (!acc) {
        acc = { commitCount: 0, filesChanged: 0, linesAdded: 0, linesDeleted: 0 };
        byDay.set(day, acc);
      }
      return acc;
    };

    for (const raw of res.stdout.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line === '') continue;
      if (line.startsWith('COMMIT ')) {
        // `COMMIT <sha> <epochSeconds>` — the epoch is the LAST whitespace field.
        const parts = line.split(/\s+/);
        const epochSec = Number(parts[parts.length - 1]);
        if (!Number.isFinite(epochSec)) {
          currentDay = null;
          continue;
        }
        currentDay = localCalendarDay(epochSec * 1000);
        ensureDay(currentDay).commitCount += 1;
        continue;
      }
      // numstat line: `<added>\t<deleted>\t<path>`. Binary files show `-`.
      if (currentDay == null) continue;
      const cols = line.split('\t');
      if (cols.length < 3) continue;
      const added = cols[0] === '-' ? 0 : Number(cols[0]);
      const deleted = cols[1] === '-' ? 0 : Number(cols[1]);
      const acc = ensureDay(currentDay);
      acc.filesChanged += 1;
      if (Number.isFinite(added)) acc.linesAdded += added;
      if (Number.isFinite(deleted)) acc.linesDeleted += deleted;
    }

    // Oldest→newest. `git log` is newest-first; YYYY-MM-DD sorts chronologically.
    const days_ = Array.from(byDay.keys()).sort();
    return days_.map((date) => {
      const acc = byDay.get(date)!;
      return {
        date,
        commitCount: acc.commitCount,
        filesChanged: acc.filesChanged,
        linesAdded: acc.linesAdded,
        linesDeleted: acc.linesDeleted,
        churn: acc.linesAdded + acc.linesDeleted,
      };
    });
  } catch {
    // Degrade to [] on ANY failure (missing git, timeout, parse) — never throw;
    // the strip simply renders nothing.
    return [];
  }
}

/** Epoch-ms → local `YYYY-MM-DD` (operator timezone, zero-padded). */
function localCalendarDay(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
