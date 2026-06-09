// v1.3.2 — Claude session-slug bridge.
//
// Why this file exists
// ────────────────────
// Claude stores chat history on disk at
//   `~/.claude/projects/<slug>/<session-id>.jsonl`
// where `<slug>` is `cwd` with every non-alphanumeric character replaced by `-`
// (see `claudeSlugForCwd` — SF-2). The slug is therefore tied to the EXACT cwd
// the `claude` process was spawned in.
//
// SigmaLink scans for sessions at the **workspace root** (`SessionStep` uses
// `selectedWorkspace.rootPath` as its `cwd` argument to `listSessionsInCwd`),
// but each pane spawns inside a **per-pane Git worktree** under
// `<userData>/worktrees/<repo-hash>/<branch-seg>`. That worktree path is
// different from the workspace root → different slug → `claude --resume <id>`
// inside the worktree cannot locate the JSONL file → Claude exits silently
// without printing a banner. The screenshot evidence in the v1.3.2 hotfix
// report shows Pane 1 (resume) blank for exactly this reason.
//
// Fix design (Option A from the hotfix plan)
// ──────────────────────────────────────────
// Before spawning `claude --resume <id>` in a worktree, **symlink** the source
// JSONL from the workspace-slug dir to the worktree-slug dir. Claude reads via
// the worktree-slug path (because that's its cwd-derived path), the symlink
// transparently resolves to the workspace file, and any APPEND Claude writes
// after the user types lands back on the original file — so the user's
// project-level history stays unified across worktrees and across launches.
//
// Symlink, not copy:
//   * Copy would diverge histories — Claude appends to its own worktree-slug
//     file, the workspace file becomes a stale snapshot.
//   * Symlink keeps a single source of truth on the filesystem.
//   * On macOS (the user's platform) and Linux, fs symlinks are first-class.
//   * Windows: `fs.promises.symlink` requires either elevated privileges OR
//     Developer Mode. The bridge falls back to a copy on Windows when the
//     symlink call fails (see `prepareClaudeResume` below). v1.3.2 ships
//     macOS-only auto-update lanes, so the Windows fallback is correctness
//     insurance, not a tested path.
//
// Pane 2 (fresh spawn, blank) — secondary fix
// ───────────────────────────────────────────
// Claude with `--session-id <new-uuid>` writes to
// `~/.claude/projects/<worktree-slug>/<new-uuid>.jsonl`. When the parent
// directory does not yet exist (always true for a brand-new per-pane worktree)
// some Claude versions silently exit before printing the banner because the
// JSONL open() fails. We pre-create the worktree-slug directory via
// `ensureClaudeProjectDir` so the first write always succeeds.
//
// Security
// ────────
// Both helpers take only the cwds + a session id. They never invoke a shell,
// never accept user-controllable command tokens, and refuse paths containing
// `..` traversal. Symlink targets are absolute and always under
// `<homeDir>/.claude/projects/` — never outside the user's own Claude data
// store. Verified clean by `aidefence_scan`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ClaudeResumeBridgeOutcome =
  | 'linked'   // symlink (or copy fallback) created and target was the source
  | 'exists'   // a link/file with the right name already exists — no-op
  | 'missing'  // source JSONL not on disk; resume cannot proceed via id
  | 'skipped'; // inputs invalid or same cwd — no bridging needed

export interface ClaudeWorkspaceContextOutcome {
  linked: string[];
  existing: string[];
  missing: string[];
  skipped: string[];
}

export interface ClaudeBridgeDeps {
  /** Override `os.homedir()` — tests inject a tmpdir. */
  homeDir?: string;
  /** Override platform — tests force the Windows copy-fallback branch. */
  platform?: NodeJS.Platform;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Claude's on-disk project slug for a given cwd.
 *
 * SF-2 (v1.29.0) — Claude derives the slug by replacing EVERY non-alphanumeric
 * character with `-`, not only `/`. Verified against claude 2.1.150:
 *   /tmp/a.b        → -private-tmp-a-b   (dot replaced)
 *   /tmp/a b        → -private-tmp-a-b   (space replaced)
 *   /tmp/a(b)c      → -private-tmp-a-b-c (parens replaced)
 *   /tmp/a..b       → -private-tmp-a--b  (1:1, NOT collapsed)
 * Case and digits are preserved. The previous implementation only replaced `/`,
 * so any cwd containing a space, dot, paren, etc. (e.g. the macOS userData path
 * `~/Library/Application Support/…`, or a worktree path with a dotted segment)
 * produced a slug that did NOT match the directory Claude actually reads. The
 * resume bridge then symlinked the session JSONL into the WRONG project dir, and
 * `claude --resume <id>` reported "No conversation found with session ID: <id>"
 * — the exact SF-2 operator symptom. Matching Claude's real rule fixes it.
 */
export function claudeSlugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Reject obviously bad paths before we touch the filesystem. */
function isSafeAbsolutePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (!path.isAbsolute(p)) return false;
  // Disallow `..` segments anywhere in the path — defence in depth even though
  // both callers pass cwds we control (workspace root or worktree path).
  // Split on BOTH separators: on win32 `path.sep` is `\`, but Node accepts
  // `/`-separated paths there too, so a POSIX-style `/tmp/../etc` previously
  // sailed straight through this guard on Windows.
  const parts = p.split(/[\\/]/);
  if (parts.some((seg) => seg === '..')) return false;
  return true;
}

/** Reject session ids that are not UUID-shaped. Tightens the surface area of
 *  what we are willing to pass through to a filesystem path. */
export function isClaudeSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Build the absolute path to `~/.claude/projects/<slug>/<id>.jsonl`. */
function jsonlPathFor(homeDir: string, slug: string, sessionId: string): string {
  return path.join(homeDir, '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/** Build the absolute path to `~/.claude/projects/<slug>/`. */
function projectDirFor(homeDir: string, slug: string): string {
  return path.join(homeDir, '.claude', 'projects', slug);
}

async function linkOrCopyContextPath(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform,
): Promise<'linked' | 'existing' | 'missing' | 'skipped'> {
  let sourceStat: fs.Stats;
  try {
    sourceStat = await fs.promises.lstat(sourcePath);
  } catch {
    return 'missing';
  }

  try {
    await fs.promises.lstat(targetPath);
    return 'existing';
  } catch {
    // ENOENT is expected.
  }

  try {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  } catch {
    return 'skipped';
  }

  try {
    await fs.promises.symlink(
      sourcePath,
      targetPath,
      sourceStat.isDirectory() ? 'dir' : 'file',
    );
    return 'linked';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'existing';
    if (code === 'EPERM' && platform === 'win32') {
      try {
        if (sourceStat.isDirectory()) {
          await fs.promises.cp(sourcePath, targetPath, { recursive: true });
        } else {
          await fs.promises.copyFile(sourcePath, targetPath);
        }
        return 'linked';
      } catch {
        return 'skipped';
      }
    }
    return 'skipped';
  }
}

/**
 * Find the index just past the end of the first complete top-level JSON value
 * in `raw` (string-aware brace/bracket depth scan). Returns null when the text
 * never closes the first value (a true mid-write truncation).
 */
function endOfFirstJsonValue(raw: string): number | null {
  let i = 0;
  while (i < raw.length && /[\s﻿]/.test(raw[i]!)) i++;
  const open = raw[i];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

export type ClaudeConfigRepairOutcome = 'ok' | 'repaired' | 'unrepairable' | 'missing';

/**
 * Self-heal `~/.claude.json` (Claude Code's global config) before a pane spawns.
 *
 * Windows pane teardown is a hard TerminateProcess (ConPTY close) — unlike the
 * catchable SIGTERM on macOS — so a Claude CLI killed mid-rewrite can leave the
 * file as a complete, shorter JSON document followed by the un-truncated tail
 * of the previous, longer version ("Extra data" / "Invalid number" parse
 * errors). Claude then blocks EVERY new pane with its interactive
 * "Configuration error … contains invalid JSON" prompt, which inside SigmaLink
 * strands all Claude panes at once.
 *
 * Repair is deliberately conservative: only the trailing-garbage shape is
 * fixed (valid first JSON value + leftover tail → atomically rewrite just the
 * valid value, keeping a `.corrupt-<ts>` forensic copy). A file that never
 * closes its first value (true truncation) is left untouched for Claude's own
 * recovery prompt. Never throws.
 */
export async function repairClaudeGlobalConfig(
  deps: ClaudeBridgeDeps = {},
): Promise<ClaudeConfigRepairOutcome> {
  const homeDir = deps.homeDir ?? os.homedir();
  const file = path.join(homeDir, '.claude.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    JSON.parse(raw.replace(/^﻿/, ''));
    return 'ok';
  } catch {
    /* corrupt — try the trailing-garbage repair below */
  }
  const end = endOfFirstJsonValue(raw);
  if (end === null) return 'unrepairable';
  const prefix = raw.slice(0, end);
  try {
    JSON.parse(prefix.replace(/^﻿/, ''));
  } catch {
    return 'unrepairable';
  }
  try {
    // Forensic copy first, then atomic temp+rename so a crash mid-repair can
    // never make things worse than they already are.
    try {
      await fs.promises.copyFile(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort */
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.repair.tmp`;
    await fs.promises.writeFile(tmp, prefix);
    await fs.promises.rename(tmp, file);
  } catch {
    return 'unrepairable';
  }
  console.warn(`[claude-config] repaired trailing-garbage corruption in ${file}`);
  return 'repaired';
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pane 2 fix — ensure the worktree-slug project directory exists BEFORE Claude
 * spawns. Some Claude versions silently exit when `--session-id <uuid>` is
 * passed but the parent directory of the target JSONL is missing.
 *
 * Idempotent: `recursive: true` makes a second call a no-op. Returns the
 * directory path for caller logging / test assertions; tests use the path,
 * the production launcher discards it.
 */
export async function ensureClaudeProjectDir(
  worktreeCwd: string,
  deps: ClaudeBridgeDeps = {},
): Promise<string | null> {
  if (!isSafeAbsolutePath(worktreeCwd)) return null;
  const homeDir = deps.homeDir ?? os.homedir();
  const slug = claudeSlugForCwd(worktreeCwd);
  const dir = projectDirFor(homeDir, slug);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  } catch {
    // mkdir failure on the user's own data dir is unrecoverable here, but we
    // never throw — the launcher's main task is to spawn the PTY. Returning
    // null lets the caller log without aborting.
    return null;
  }
}

/**
 * Make workspace-local Claude context visible inside an isolated worktree.
 *
 * `git worktree add` only checks out tracked files. User-local Claude context
 * is often intentionally ignored (`CLAUDE.md`, `.claude/`), so a pane spawned
 * from the worktree can miss the exact project instructions/config that made
 * the original workspace session resumable. We link those files into the
 * worktree cwd without overwriting anything already present there.
 */
export async function prepareClaudeWorkspaceContext(
  workspaceCwd: string,
  worktreeCwd: string,
  deps: ClaudeBridgeDeps = {},
): Promise<ClaudeWorkspaceContextOutcome> {
  // Every Claude spawn path (launch / resume / respawn / swarm) calls this
  // first, so self-heal the global config HERE — before the early returns, so
  // in-place workspaces (workspaceCwd === worktreeCwd) are covered too.
  await repairClaudeGlobalConfig(deps);

  const outcome: ClaudeWorkspaceContextOutcome = {
    linked: [],
    existing: [],
    missing: [],
    skipped: [],
  };
  if (!isSafeAbsolutePath(workspaceCwd) || !isSafeAbsolutePath(worktreeCwd)) {
    outcome.skipped.push('workspace');
    return outcome;
  }
  if (workspaceCwd === worktreeCwd) return outcome;

  const platform = deps.platform ?? process.platform;
  for (const name of ['CLAUDE.md', '.claude']) {
    const sourcePath = path.join(workspaceCwd, name);
    const targetPath = path.join(worktreeCwd, name);
    const result = await linkOrCopyContextPath(sourcePath, targetPath, platform);
    outcome[result].push(name);
  }
  return outcome;
}

/**
 * Pane 1 fix — bridge the resume JSONL from the workspace-slug dir into the
 * worktree-slug dir so `claude --resume <id>` spawned inside the worktree can
 * find it.
 *
 * Algorithm:
 *   1. If `workspaceCwd === worktreeCwd` (e.g. non-Git workspace, no worktree
 *      pool) the slugs match → no bridging needed → returns 'skipped'.
 *   2. Compute the workspace-slug JSONL path and stat it. If missing, the
 *      caller should drop the `--resume <id>` flag in favour of `--continue`
 *      (the universal fallback). Returns 'missing'.
 *   3. Compute the worktree-slug JSONL path. If something already exists at
 *      that location (regular file, symlink, anything), return 'exists' — we
 *      do not overwrite. The most common case is a previous launch in the
 *      same worktree already created the link.
 *   4. Otherwise, `mkdir -p` the worktree-slug dir and create a symlink whose
 *      target is the ABSOLUTE workspace-slug JSONL path. Returns 'linked'.
 *
 * Windows fallback: `fs.promises.symlink` may throw EPERM on Windows when
 * neither admin nor Developer Mode is enabled. We catch and fall back to a
 * one-time copy + log so resume at least works once; subsequent launches see
 * the copy and return 'exists' but lose the unified-history property. v1.3.2
 * does not ship a Windows installer for this hotfix, so the fallback is
 * defensive insurance.
 */
export async function prepareClaudeResume(
  workspaceCwd: string,
  worktreeCwd: string,
  sessionId: string,
  deps: ClaudeBridgeDeps = {},
): Promise<ClaudeResumeBridgeOutcome> {
  if (!isSafeAbsolutePath(workspaceCwd)) return 'skipped';
  if (!isSafeAbsolutePath(worktreeCwd)) return 'skipped';
  if (!isClaudeSessionId(sessionId)) return 'skipped';

  const homeDir = deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const workspaceSlug = claudeSlugForCwd(workspaceCwd);
  const sourcePath = jsonlPathFor(homeDir, workspaceSlug, sessionId);

  // In-place workspace (slugs identical, e.g. no-worktree mode): there is
  // nothing to bridge, BUT the conversation JSONL must still exist in that slug.
  // If it was deleted / aged out, `claude --resume <id>` prints "No conversation
  // found with session ID: <id>" and drops to a bare shell. Treat an absent
  // JSONL as 'missing' so the caller falls back to `--continue` instead of
  // resuming a ghost id. (Surfaced once the boot-restore race fix made in-place
  // panes actually resume — previously this returned 'skipped' unconditionally.)
  if (workspaceCwd === worktreeCwd) {
    try {
      await fs.promises.stat(sourcePath);
      return 'skipped';
    } catch {
      return 'missing';
    }
  }

  const worktreeSlug = claudeSlugForCwd(worktreeCwd);
  const targetPath = jsonlPathFor(homeDir, worktreeSlug, sessionId);

  // Step 2 — source must exist; otherwise caller falls back to --continue.
  try {
    await fs.promises.stat(sourcePath);
  } catch {
    return 'missing';
  }

  // Step 3 — already linked / copied.
  try {
    await fs.promises.lstat(targetPath);
    return 'exists';
  } catch {
    // ENOENT is the happy path; continue.
  }

  // Step 4 — ensure parent dir + create the symlink.
  const targetDir = projectDirFor(homeDir, worktreeSlug);
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
  } catch {
    return 'skipped';
  }

  try {
    await fs.promises.symlink(sourcePath, targetPath);
    return 'linked';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Raced with another pane in the same worktree (extremely unlikely —
      // worktree paths are unique per pane). Treat as success.
      return 'exists';
    }
    // Windows EPERM fallback: copy the file once. Subsequent calls see the
    // copy via the 'exists' branch above. Logged via the outcome value — the
    // launcher does not currently surface a toast for this.
    if (code === 'EPERM' && platform === 'win32') {
      try {
        await fs.promises.copyFile(sourcePath, targetPath);
        return 'linked';
      } catch {
        return 'skipped';
      }
    }
    return 'skipped';
  }
}
