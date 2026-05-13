// v1.2.8 — disk-based session id capture for providers that lack a
// pre-assignment flag (codex, kimi, opencode).
//
// Each provider stores its sessions in a known on-disk location, with the
// UUID either in the filename or in a leaf directory name. Two seconds after
// spawn (and again at +5s / +15s if the first attempt missed), the PTY
// registry calls `findLatestSessionId(providerId, cwd)` here; on a hit, the
// caller writes the captured id into `agent_sessions.external_session_id`.
//
// Design notes:
//   * We scan AT THE SCAN TIME, not at spawn time, so a CLI that takes 1-2s
//     to materialise its session file still gets captured.
//   * We scope by mtime within the last `SCAN_WINDOW_MS` so a stale session
//     from yesterday cannot be mis-attributed to a fresh pane. For codex this
//     means we only consider rollout files written in the same boot window.
//   * `cwd` is recorded but not strictly required for matching — disk layouts
//     for kimi/opencode already partition by project; codex does not, and we
//     fall back to "newest in window" as the v1 simplification per plan.
//   * `opencode` requires shelling out to `opencode session list --format
//     json`; we tolerate any exit code other than a successful JSON parse.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Only consider session files modified within this window (ms). */
const DEFAULT_SCAN_WINDOW_MS = 5 * 60 * 1000;

/** Hard ceiling on `find`-style recursion depth so a pathological tree never
 *  hangs the main process. */
const MAX_RECURSION_DEPTH = 6;

/** Hard ceiling on entries scanned per directory pass so a runaway provider
 *  cache cannot starve the event loop. */
const MAX_ENTRIES_PER_DIR = 500;

export interface DiskScanOptions {
  /** Override the home dir (tests inject a tmpdir). */
  homeDir?: string;
  /** Override "now" (tests pin time). */
  now?: number;
  /** Override the mtime window. */
  scanWindowMs?: number;
  /** Tests inject a fake opencode CLI runner. */
  runOpencodeList?: (cwd: string) => Promise<string>;
}

interface CandidateFile {
  /** Absolute path on disk (file for codex, directory for kimi). */
  fullPath: string;
  /** Extracted UUID; never empty when emitted. */
  sessionId: string;
  /** mtime in epoch ms — used to pick the newest among siblings. */
  mtimeMs: number;
}

/** UUID v4 shape; tolerant of v1-v5 by not pinning the version nibble. */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isWithinWindow(mtimeMs: number, now: number, windowMs: number): boolean {
  return now - mtimeMs >= 0 && now - mtimeMs <= windowMs;
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function safeReadDir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Walk a tree breadth-first up to `MAX_RECURSION_DEPTH`, yielding files that
 * match `predicate`. Used for codex's `~/.codex/sessions/YYYY/MM/DD/` layout
 * where the date partitions are not deterministic for us (we don't know which
 * folder the running CLI just touched).
 */
function findFiles(
  root: string,
  predicate: (name: string) => boolean,
  maxDepth = MAX_RECURSION_DEPTH,
): string[] {
  const matches: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    const entries = safeReadDir(dir).slice(0, MAX_ENTRIES_PER_DIR);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && predicate(entry.name)) {
        matches.push(full);
      }
    }
  }
  return matches;
}

/**
 * Codex stores rollouts at
 *   `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`
 * (one file per session). We extract `<uuid>` from the filename and pick the
 * newest one whose mtime falls within the scan window.
 *
 * The plan documents an option to cross-reference cwd from the JSONL's first
 * metadata line; v1 keeps this simple (newest-in-window) per the plan's
 * explicit simplification clause.
 */
function findCodexSession(
  homeDir: string,
  cwd: string,
  now: number,
  windowMs: number,
): CandidateFile | null {
  const root = path.join(homeDir, '.codex', 'sessions');
  if (!safeStat(root)) return null;
  const files = findFiles(root, (name) => /^rollout-.*\.jsonl$/i.test(name));
  let best: CandidateFile | null = null;
  for (const file of files) {
    const stat = safeStat(file);
    if (!stat) continue;
    if (!isWithinWindow(stat.mtimeMs, now, windowMs)) continue;
    const base = path.basename(file);
    const match = base.match(UUID_RE);
    if (!match) continue;
    const candidate: CandidateFile = {
      fullPath: file,
      sessionId: match[0],
      mtimeMs: stat.mtimeMs,
    };
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  // Reference cwd in a way that survives lint without changing semantics —
  // future revisions may cross-check the rollout's first-line `cwd` metadata.
  void cwd;
  return best;
}

/**
 * Kimi stores sessions at `~/.kimi/sessions/<project>/<uuid>/...`. The plan
 * notes the project hash convention is not deterministic for us, so we walk
 * `~/.kimi/sessions/` two levels deep and pick the newest UUID-shaped leaf
 * directory whose mtime falls inside the scan window.
 */
function findKimiSession(
  homeDir: string,
  cwd: string,
  now: number,
  windowMs: number,
): CandidateFile | null {
  const root = path.join(homeDir, '.kimi', 'sessions');
  if (!safeStat(root)) return null;
  void cwd; // future: SHA1(cwd) cross-check if upstream stabilises
  let best: CandidateFile | null = null;
  // Two-level walk: top entry is the project bucket; second-level entries are
  // the session UUID dirs. We tolerate sessions stored directly under
  // `~/.kimi/sessions/<uuid>/` too (some installs flatten the project hash).
  const projectEntries = safeReadDir(root).slice(0, MAX_ENTRIES_PER_DIR);
  const sessionDirs: string[] = [];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    // If the directory name itself looks like a UUID, treat it as a session.
    if (UUID_RE.test(entry.name)) {
      sessionDirs.push(full);
      continue;
    }
    // Otherwise treat it as a project bucket and list its UUID children.
    for (const child of safeReadDir(full).slice(0, MAX_ENTRIES_PER_DIR)) {
      if (!child.isDirectory()) continue;
      if (!UUID_RE.test(child.name)) continue;
      sessionDirs.push(path.join(full, child.name));
    }
  }
  for (const dir of sessionDirs) {
    const stat = safeStat(dir);
    if (!stat) continue;
    if (!isWithinWindow(stat.mtimeMs, now, windowMs)) continue;
    const match = path.basename(dir).match(UUID_RE);
    if (!match) continue;
    const candidate: CandidateFile = {
      fullPath: dir,
      sessionId: match[0],
      mtimeMs: stat.mtimeMs,
    };
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best;
}

/**
 * OpenCode exposes its session catalogue via subprocess. We shell out to
 * `opencode session list --format json --max-count 10`, parse the JSON,
 * filter by `directory === cwd`, and return the newest `updated` row's id.
 *
 * Tests inject `runOpencodeList` so the subprocess is never spawned.
 */
async function findOpencodeSession(
  cwd: string,
  now: number,
  windowMs: number,
  runner?: (cwd: string) => Promise<string>,
): Promise<CandidateFile | null> {
  const runOnce = runner ?? defaultOpencodeRunner;
  let json: string;
  try {
    json = await runOnce(cwd);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [];
  let best: CandidateFile | null = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    if (!id) continue;
    const directory = typeof r.directory === 'string' ? r.directory : null;
    if (directory && directory !== cwd) continue;
    const updatedRaw = r.updated;
    let mtimeMs: number;
    if (typeof updatedRaw === 'number') {
      // OpenCode timestamps may be in seconds or milliseconds depending on
      // version; normalise to ms.
      mtimeMs = updatedRaw > 1e12 ? updatedRaw : updatedRaw * 1000;
    } else if (typeof updatedRaw === 'string') {
      const parsedDate = Date.parse(updatedRaw);
      if (!Number.isFinite(parsedDate)) continue;
      mtimeMs = parsedDate;
    } else {
      continue;
    }
    if (!isWithinWindow(mtimeMs, now, windowMs)) continue;
    if (!best || mtimeMs > best.mtimeMs) {
      best = { fullPath: '', sessionId: id, mtimeMs };
    }
  }
  return best;
}

async function defaultOpencodeRunner(cwd: string): Promise<string> {
  // 5s timeout on the probe — OpenCode itself starts fast; if it hangs we'd
  // rather give up than block the retry schedule.
  const { stdout } = await execFileAsync(
    'opencode',
    ['session', 'list', '--format', 'json', '--max-count', '10'],
    { cwd, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
  );
  return stdout;
}

/**
 * Public entry point. Returns the UUID of the newest matching session for
 * `providerId` in `cwd`, or null if nothing within the scan window matched.
 *
 * Providers that have a pre-assign path (claude, gemini) and the internal
 * `shell` / `custom` sentinels are out of scope and always return null.
 */
export async function findLatestSessionId(
  providerId: string,
  cwd: string,
  opts: DiskScanOptions = {},
): Promise<string | null> {
  const homeDir = opts.homeDir ?? os.homedir();
  const now = opts.now ?? Date.now();
  const windowMs = opts.scanWindowMs ?? DEFAULT_SCAN_WINDOW_MS;
  const provider = providerId.trim().toLowerCase();
  let hit: CandidateFile | null = null;
  if (provider === 'codex') {
    hit = findCodexSession(homeDir, cwd, now, windowMs);
  } else if (provider === 'kimi') {
    hit = findKimiSession(homeDir, cwd, now, windowMs);
  } else if (provider === 'opencode') {
    hit = await findOpencodeSession(cwd, now, windowMs, opts.runOpencodeList);
  }
  return hit?.sessionId ?? null;
}

/** Provider ids that participate in disk-scan capture. Exported so the
 *  registry can avoid scheduling retries for providers that don't need it. */
export const DISK_SCAN_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'kimi',
  'opencode',
]);

/**
 * Retry schedule (ms post-spawn). Bounded so a CLI that never writes its
 * session file does not generate retries indefinitely.
 */
export const DISK_SCAN_RETRY_SCHEDULE_MS: ReadonlyArray<number> = [
  2_000,
  5_000,
  15_000,
];
