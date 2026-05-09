// Diff + conflict computation for the Review Room.
//
// Edge cases handled:
//  - Detached HEAD (worktree on a non-branch ref) → fall back to plain `HEAD`.
//  - Submodules → silently skipped (we never recurse via --recurse-submodules).
//  - LFS pointer files → flow through normally; we don't try to fetch contents.
//  - Large repos → cap the patch fetch at ~16 MiB; if exceeded, mark
//    `truncated: true` and keep the first ~5 MiB of patches plus the full stat.

import path from 'node:path';
import fs from 'node:fs';
import { execCmd } from '../../lib/exec';
import { getRepoRoot } from '../git/git-ops';
import { mergePreview } from '../git/git-ops';
import type { DiffFileSummary, ReviewDiff, ReviewConflict } from './types';

/** Total stdout cap on `git diff HEAD` (raw bytes, before utf-8 decode). */
export const DIFF_HARD_CAP = 16 * 1024 * 1024;
/** Truncation threshold: when the raw output is larger than this, we keep
 *  only this many bytes of patches in the response. */
export const DIFF_KEEP_BYTES = 5 * 1024 * 1024;

function parseNameStatus(text: string): DiffFileSummary[] {
  const out: DiffFileSummary[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const parts = raw.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0];
    // R/C have similarity score after the letter; pick the new path (last col).
    const newPath = parts[parts.length - 1];
    const oldPath = parts.length >= 3 ? parts[1] : undefined;
    let status: DiffFileSummary['status'];
    const c = code[0];
    if (c === 'A') status = 'A';
    else if (c === 'M') status = 'M';
    else if (c === 'D') status = 'D';
    else if (c === 'R') status = 'R';
    else if (c === 'C') status = 'C';
    else if (c === 'T') status = 'T';
    else status = 'M';
    out.push({ path: newPath, oldPath, status, additions: 0, deletions: 0 });
  }
  return out;
}

function mergeNumstat(files: DiffFileSummary[], numstat: string): DiffFileSummary[] {
  const map = new Map<string, DiffFileSummary>();
  for (const f of files) map.set(f.path, f);
  for (const line of numstat.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const adds = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const dels = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    const filePath = parts[parts.length - 1];
    const existing = map.get(filePath);
    if (existing) {
      existing.additions = adds;
      existing.deletions = dels;
      existing.binary = parts[0] === '-' && parts[1] === '-';
    } else {
      map.set(filePath, {
        path: filePath,
        status: 'M',
        additions: adds,
        deletions: dels,
        binary: parts[0] === '-' && parts[1] === '-',
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build the cross-process `ReviewDiff` shape for one worktree. Returns null
 * if the path is missing or not a git repo.
 */
export async function computeReviewDiff(worktreePath: string): Promise<ReviewDiff | null> {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  const root = await getRepoRoot(worktreePath);
  if (!root) return null;

  const headRefRes = await execCmd('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: worktreePath,
    timeoutMs: 5_000,
  });
  // Detached HEAD: symbolic-ref exits non-zero. We continue with `HEAD` as the
  // target; everything below tolerates this.
  const detached = headRefRes.code !== 0;

  const [nameStatusRes, numstatRes, untrackedRes] = await Promise.all([
    execCmd('git', ['diff', '--name-status', 'HEAD', '--no-renames'], {
      cwd: worktreePath,
      timeoutMs: 8_000,
    }),
    execCmd('git', ['diff', '--numstat', 'HEAD'], {
      cwd: worktreePath,
      timeoutMs: 8_000,
    }),
    execCmd('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      timeoutMs: 5_000,
    }),
  ]);

  const filesFromStatus = parseNameStatus(nameStatusRes.stdout);
  const files = mergeNumstat(filesFromStatus, numstatRes.stdout);
  const untrackedFiles = untrackedRes.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((p) => {
      // Drop submodule directory entries (git lists them as untracked when
      // their .git is a gitlink with no local commits).
      try {
        const full = path.join(worktreePath, p);
        const st = fs.statSync(full);
        return !st.isDirectory();
      } catch {
        return true;
      }
    });
  for (const u of untrackedFiles) {
    files.push({ path: u, status: 'U', additions: 0, deletions: 0 });
  }

  // Patch body — capped to DIFF_HARD_CAP and trimmed to DIFF_KEEP_BYTES on
  // overflow. We use --no-color so the renderer can syntax-highlight.
  const patchRes = await execCmd('git', ['diff', 'HEAD', '--no-color'], {
    cwd: worktreePath,
    timeoutMs: 20_000,
    maxBuffer: DIFF_HARD_CAP,
  });
  const fullPatch = patchRes.stdout;
  let patches = fullPatch;
  let truncated = false;
  if (Buffer.byteLength(fullPatch, 'utf8') >= DIFF_HARD_CAP - 1) {
    truncated = true;
    patches = fullPatch.slice(0, DIFF_KEEP_BYTES);
    patches += '\n\n*** diff truncated by SigmaLink: full patch exceeds budget ***\n';
  }

  const stat = (
    await execCmd('git', ['diff', '--stat', 'HEAD'], {
      cwd: worktreePath,
      timeoutMs: 8_000,
    })
  ).stdout;

  return {
    repoRoot: root,
    branch: detached ? 'HEAD (detached)' : '',
    files,
    patches,
    stat,
    truncated,
    detached,
  };
}

/**
 * Conflict prediction for a worktree branch against its workspace base ref.
 * The result is the same shape consumed by the Review Room "Conflicts" tab.
 */
export async function computeConflicts(input: {
  repoRoot: string;
  worktreeBranch: string | null;
  base: string;
}): Promise<ReviewConflict[]> {
  if (!input.worktreeBranch) return [];
  const preview = await mergePreview(input.repoRoot, input.base, input.worktreeBranch);
  return preview.conflicts.map((p) => ({
    path: p,
    method: preview.method,
  }));
}
