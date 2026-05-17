// v1.4.3-01 — Gemini session-slug bridge.
//
// Why this file exists
// ────────────────────
// Gemini stores chat history on disk at
//   `~/.gemini/tmp/<slug>/chats/session-YYYY-MM-DDThh-mm-<short>.jsonl`
// where `<slug>` is derived from the cwd registered in `~/.gemini/projects.json`
// (typically the basename of the project directory). The slug is therefore tied
// to the EXACT cwd the `gemini` process was spawned in.
//
// SigmaLink spawns each pane inside a **per-pane Git worktree** whose path
// differs from the workspace root. Gemini would create a new slug for the
// worktree path, so `~/.gemini/tmp/<worktree-slug>/chats/` is empty — the
// session history lives under `<workspace-slug>/chats/`. Even if SigmaLink
// fell back to `--resume latest`, gemini would exit 1 because the worktree
// slug's chats directory contains no sessions.
//
// Fix design (projects.json alias approach)
// ─────────────────────────────────────────
// Before spawning `gemini --resume latest` in a worktree, register an ALIAS
// in `~/.gemini/projects.json`: `{ "<worktreeCwd>": "<workspaceSlug>" }`.
// Gemini reads this file on startup and uses the mapped slug for the worktree
// path, so it reads from the SAME chats directory as the workspace cwd.
//
// NOT symlinks (contrast with claude-resume-bridge.ts which uses symlinks).
// Gemini's projects.json design supports the alias approach natively; it is
// cleaner and avoids platform-specific symlink permission issues.
//
// Security
// ────────
// Helpers take only cwd paths and a homeDir override. No shell invocations.
// Paths containing `..` traversal segments are refused. projects.json writes
// are atomic (tmp-rename). Verified clean by aidefence_scan.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GeminiResumeBridgeOutcome =
  | 'aliased'   // projects.json now maps worktreeCwd → workspaceSlug
  | 'exists'    // mapping already in place; no-op
  | 'missing'   // workspaceSlug has no sessions; caller must drop resume args
  | 'skipped';  // workspaceCwd === worktreeCwd; bridge unnecessary

export interface GeminiBridgeDeps {
  /** Override `os.homedir()` — tests inject a tmpdir. */
  homeDir?: string;
  /** Override platform — reserved for future use. */
  platform?: NodeJS.Platform;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Reject obviously bad paths before we touch the filesystem. */
function isSafeAbsolutePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (!path.isAbsolute(p)) return false;
  // Disallow `..` segments anywhere in the path — defence in depth.
  const parts = p.split(path.sep);
  if (parts.some((seg) => seg === '..')) return false;
  return true;
}

/** Absolute path to `~/.gemini/projects.json`. */
function projectsJsonPath(homeDir: string): string {
  return path.join(homeDir, '.gemini', 'projects.json');
}

/** Absolute path to `~/.gemini/tmp/<slug>/chats/`. */
function chatsDirFor(homeDir: string, slug: string): string {
  return path.join(homeDir, '.gemini', 'tmp', slug, 'chats');
}

/**
 * Read-and-parse `~/.gemini/projects.json`.
 * Returns the parsed object (which must be a flat `{ [cwd: string]: string }`
 * map) or null on any error (missing file, parse error, wrong type).
 */
async function readProjectsJson(
  homeDir: string,
): Promise<Record<string, string> | null> {
  const filePath = projectsJsonPath(homeDir);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  // Validate every value is a string (shallow check; tolerates extra keys).
  const map = parsed as Record<string, unknown>;
  for (const [, v] of Object.entries(map)) {
    if (typeof v !== 'string') return null;
  }
  return map as Record<string, string>;
}

/**
 * Atomic write of `~/.gemini/projects.json`.
 * Uses a tmp file + rename so a crash mid-write leaves the old file intact.
 */
async function writeProjectsJsonAtomic(
  homeDir: string,
  data: Record<string, string>,
): Promise<void> {
  const filePath = projectsJsonPath(homeDir);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2) + '\n';
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute gemini's slug for a given cwd.
 *
 * Reads `~/.gemini/projects.json` first to honour any existing registration;
 * falls back to `path.basename(cwd)` when no entry exists.
 *
 * This mirrors how gemini itself derives the slug: it writes `basename(cwd)`
 * into projects.json on first launch, so our fallback is faithful.
 */
export async function geminiSlugForCwd(
  homeDir: string,
  cwd: string,
): Promise<string> {
  const map = await readProjectsJson(homeDir);
  if (map && typeof map[cwd] === 'string' && map[cwd].length > 0) {
    return map[cwd];
  }
  return path.basename(cwd);
}

/**
 * Read `~/.gemini/projects.json` and return the slug mapped to `cwd`, or
 * null if the file is missing, malformed, or contains no entry for `cwd`.
 */
export async function lookupGeminiSlug(
  homeDir: string,
  cwd: string,
): Promise<string | null> {
  const map = await readProjectsJson(homeDir);
  if (!map) return null;
  const v = map[cwd];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pre-create `~/.gemini/tmp/<workspaceSlug>/{chats,tool-outputs}/` AND
 * register `worktreeCwd → workspaceSlug` in `~/.gemini/projects.json`
 * atomically so gemini reads the SAME chats dir from both cwds.
 *
 * Called for every gemini spawn (fresh OR resume). Idempotent.
 * Returns the chats directory path for caller logging, or null on failure
 * (spawn proceeds regardless — never throws).
 */
export async function ensureGeminiProjectDir(
  worktreeCwd: string,
  workspaceCwd: string,
  deps: GeminiBridgeDeps = {},
): Promise<string | null> {
  if (!isSafeAbsolutePath(worktreeCwd)) return null;
  if (!isSafeAbsolutePath(workspaceCwd)) return null;

  const homeDir = deps.homeDir ?? os.homedir();

  // Determine the authoritative slug from the workspace cwd.
  const workspaceSlug = await geminiSlugForCwd(homeDir, workspaceCwd);

  // Verify the slug stays within ~/.gemini/tmp/ (no breakout).
  const chatsDir = chatsDirFor(homeDir, workspaceSlug);
  const geminiTmpRoot = path.join(homeDir, '.gemini', 'tmp');
  if (!chatsDir.startsWith(geminiTmpRoot + path.sep)) return null;

  // Pre-create chats/ and tool-outputs/ directories.
  try {
    await fs.promises.mkdir(chatsDir, { recursive: true });
    await fs.promises.mkdir(
      path.join(homeDir, '.gemini', 'tmp', workspaceSlug, 'tool-outputs'),
      { recursive: true },
    );
  } catch {
    // Directory creation failure is non-fatal; return null so the launcher
    // can log but still proceeds with the spawn.
    return null;
  }

  // Register the alias only when worktreeCwd differs from workspaceCwd.
  if (worktreeCwd !== workspaceCwd) {
    try {
      // READ-MERGE-WRITE atomically so concurrent pane spawns do not clobber
      // each other's entries. Low-level race described in R-01-2 is documented
      // for v1.4.4; this is best-effort for v1.4.3.
      const existing = (await readProjectsJson(homeDir)) ?? {};
      if (existing[worktreeCwd] !== workspaceSlug) {
        existing[worktreeCwd] = workspaceSlug;
        await writeProjectsJsonAtomic(homeDir, existing);
      }
    } catch {
      // projects.json write failure is non-fatal; gemini may still spawn
      // fresh (without history), which is better than blocking the spawn.
    }
  }

  return chatsDir;
}

/**
 * Determine if gemini can resume in `worktreeCwd` by aliasing to
 * `workspaceCwd`'s slug.
 *
 * Algorithm:
 *   1. `workspaceCwd === worktreeCwd` → no bridging needed → 'skipped'.
 *   2. Resolve the workspaceSlug for `workspaceCwd`.
 *   3. Check whether `~/.gemini/tmp/<workspaceSlug>/chats/` contains ANY
 *      `session-*.jsonl` file. If empty → 'missing' (caller drops --resume).
 *   4. Check if `worktreeCwd` is already mapped to `workspaceSlug` in
 *      projects.json → 'exists' (idempotent, no write).
 *   5. Register the alias → 'aliased'.
 */
export async function prepareGeminiResume(
  workspaceCwd: string,
  worktreeCwd: string,
  deps: GeminiBridgeDeps = {},
): Promise<GeminiResumeBridgeOutcome> {
  if (!isSafeAbsolutePath(workspaceCwd)) return 'skipped';
  if (!isSafeAbsolutePath(worktreeCwd)) return 'skipped';

  // Step 1 — same cwd: no bridging needed.
  if (workspaceCwd === worktreeCwd) return 'skipped';

  const homeDir = deps.homeDir ?? os.homedir();

  // Step 2 — resolve workspace slug.
  const workspaceSlug = await geminiSlugForCwd(homeDir, workspaceCwd);

  // Verify the slug stays within ~/.gemini/tmp/ (no breakout).
  const chatsDir = chatsDirFor(homeDir, workspaceSlug);
  const geminiTmpRoot = path.join(homeDir, '.gemini', 'tmp');
  if (!chatsDir.startsWith(geminiTmpRoot + path.sep)) return 'skipped';

  // Step 3 — check whether workspaceSlug's chats directory has sessions.
  let hasSession = false;
  try {
    const entries = await fs.promises.readdir(chatsDir);
    hasSession = entries.some(
      (name) => name.startsWith('session-') && name.endsWith('.jsonl'),
    );
  } catch {
    // chatsDir doesn't exist yet — treat as no sessions.
    hasSession = false;
  }
  if (!hasSession) return 'missing';

  // Step 4 — check existing mapping.
  const existing = (await readProjectsJson(homeDir)) ?? {};
  if (existing[worktreeCwd] === workspaceSlug) return 'exists';

  // Step 5 — register the alias.
  try {
    existing[worktreeCwd] = workspaceSlug;
    await writeProjectsJsonAtomic(homeDir, existing);
  } catch {
    // Write failure: return 'skipped' so caller doesn't attempt resume with
    // a potentially wrong slug. Fresh spawn is safer than a bad resume.
    return 'skipped';
  }

  return 'aliased';
}
