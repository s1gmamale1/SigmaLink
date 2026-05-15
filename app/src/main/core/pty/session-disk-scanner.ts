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

/**
 * v1.3.0 — A single session entry returned by `listSessionsInCwd`.
 * Mirrors the shape described in the v1.3.0 plan § disk-scan-extension-audit.
 */
export interface SessionListItem {
  id: string;
  providerId: string;
  cwd: string;
  /** epoch ms — from the JSONL first-line `created_at`, or mtime fallback. */
  createdAt: number;
  /** epoch ms — file/dir mtime. */
  updatedAt: number;
  /** Optional provider-surfaced session title. */
  title?: string;
  /** First user message text, truncated to 80 chars. */
  firstMessagePreview?: string;
}

/** Options for `listSessionsInCwd`. */
export interface ListSessionsOptions extends DiskScanOptions {
  /** Maximum items returned (default 50). */
  maxCount?: number;
  /** Only include sessions updated within the last `sinceMs` ms. Pass 0 or
   *  omit to return all (no mtime gate, unlike `findLatestSessionId`). */
  sinceMs?: number;
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

// ─────────────────────────────────────────────────────────────────────────
// v1.3.0 — per-provider list helpers
// ─────────────────────────────────────────────────────────────────────────

/** Read the first line of a JSONL file; returns '' on any error. */
function readFirstLine(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const raw = buf.slice(0, n).toString('utf8');
    return raw.split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

/** Truncate a string to maxLen characters. */
function trunc(s: string, maxLen = 80): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

/**
 * Claude stores sessions at `~/.claude/projects/<slug>/<uuid>.jsonl` where
 * slug = `cwd.replace(/\//g, '-')`.  The first JSONL line is the session-init
 * metadata blob: `{ "type": "system", ... }` followed by user turns.
 * v1.3.0 plan: extract `created_at` + first user message text.
 *
 * Returns up to `maxCount` items sorted by updatedAt DESC.
 */
function listClaudeSessions(
  homeDir: string,
  cwd: string,
  maxCount: number,
  sinceMs: number | undefined,
): SessionListItem[] {
  const slug = cwd.replace(/\//g, '-');
  const projectDir = path.join(homeDir, '.claude', 'projects', slug);
  if (!safeStat(projectDir)) return [];
  const entries = safeReadDir(projectDir).filter(
    (e) => e.isFile() && e.name.endsWith('.jsonl') && UUID_RE.test(path.basename(e.name, '.jsonl')),
  );
  const items: SessionListItem[] = [];
  for (const entry of entries) {
    const filePath = path.join(projectDir, entry.name);
    const stat = safeStat(filePath);
    if (!stat) continue;
    const updatedAt = stat.mtimeMs;
    if (sinceMs !== undefined && sinceMs > 0 && Date.now() - updatedAt > sinceMs) continue;
    const uuid = path.basename(entry.name, '.jsonl');
    // Parse first line for metadata
    let createdAt = updatedAt;
    let firstMessagePreview: string | undefined;
    const firstLine = readFirstLine(filePath);
    if (firstLine) {
      try {
        const meta = JSON.parse(firstLine) as Record<string, unknown>;
        if (typeof meta.created_at === 'number') createdAt = meta.created_at;
        else if (typeof meta.created_at === 'string') {
          const p = Date.parse(meta.created_at);
          if (Number.isFinite(p)) createdAt = p;
        }
      } catch {
        // ignore — use mtime as fallback
      }
    }
    // Scan lines for first user message
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === 'user') {
            const content = parsed.message ?? parsed.content ?? parsed.text;
            if (typeof content === 'string' && content.trim()) {
              firstMessagePreview = trunc(content.trim());
              break;
            }
            // Handle array content (Anthropic messages API shape)
            if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block === 'object' && block !== null) {
                  const b = block as Record<string, unknown>;
                  if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                    firstMessagePreview = trunc(b.text.trim());
                    break;
                  }
                }
              }
              if (firstMessagePreview) break;
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }
    items.push({ id: uuid, providerId: 'claude', cwd, createdAt, updatedAt, firstMessagePreview });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxCount);
}

/**
 * Codex: list all rollout JSONL files under `~/.codex/sessions/`.
 * No mtime gate (unlike `findCodexSession`) — list variant returns everything
 * sorted DESC, capped at `maxCount`.
 */
function listCodexSessions(
  homeDir: string,
  cwd: string,
  maxCount: number,
  sinceMs: number | undefined,
): SessionListItem[] {
  const root = path.join(homeDir, '.codex', 'sessions');
  if (!safeStat(root)) return [];
  const files = findFiles(root, (name) => /^rollout-.*\.jsonl$/i.test(name));
  const items: SessionListItem[] = [];
  for (const file of files) {
    const stat = safeStat(file);
    if (!stat) continue;
    const updatedAt = stat.mtimeMs;
    if (sinceMs !== undefined && sinceMs > 0 && Date.now() - updatedAt > sinceMs) continue;
    const base = path.basename(file);
    const uuidMatch = base.match(UUID_RE);
    if (!uuidMatch) continue;
    const uuid = uuidMatch[0];
    // ISO timestamp from filename: rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
    const tsMatch = base.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
    let createdAt = updatedAt;
    if (tsMatch) {
      const isoStr = tsMatch[1].replace(/-(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
      const p = Date.parse(isoStr);
      if (Number.isFinite(p)) createdAt = p;
    }
    // First user message from first JSONL line
    let firstMessagePreview: string | undefined;
    const firstLine = readFirstLine(file);
    if (firstLine) {
      try {
        const meta = JSON.parse(firstLine) as Record<string, unknown>;
        const msg = meta.user_message ?? meta.message ?? meta.text;
        if (typeof msg === 'string' && msg.trim()) {
          firstMessagePreview = trunc(msg.trim());
        }
      } catch {
        // ignore
      }
    }
    items.push({ id: uuid, providerId: 'codex', cwd, createdAt, updatedAt, firstMessagePreview });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxCount);
}

/**
 * Kimi: list session UUID directories under `~/.kimi/sessions/<sha1(cwd)>/<uuid>/`
 * and attempt to read `state.json` for metadata.
 * Falls back to mtime if `state.json` is missing or unparseable.
 */
function listKimiSessions(
  homeDir: string,
  cwd: string,
  maxCount: number,
  sinceMs: number | undefined,
): SessionListItem[] {
  const root = path.join(homeDir, '.kimi', 'sessions');
  if (!safeStat(root)) return [];
  // Collect all UUID-shaped session directories (two-level or flat).
  const sessionDirs: string[] = [];
  const projectEntries = safeReadDir(root).slice(0, MAX_ENTRIES_PER_DIR);
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (UUID_RE.test(entry.name)) {
      sessionDirs.push(full);
    } else {
      for (const child of safeReadDir(full).slice(0, MAX_ENTRIES_PER_DIR)) {
        if (!child.isDirectory()) continue;
        if (!UUID_RE.test(child.name)) continue;
        sessionDirs.push(path.join(full, child.name));
      }
    }
  }
  const items: SessionListItem[] = [];
  for (const dir of sessionDirs) {
    const stat = safeStat(dir);
    if (!stat) continue;
    const updatedAt = stat.mtimeMs;
    if (sinceMs !== undefined && sinceMs > 0 && Date.now() - updatedAt > sinceMs) continue;
    const uuid = path.basename(dir).match(UUID_RE)?.[0];
    if (!uuid) continue;
    let createdAt = updatedAt;
    let title: string | undefined;
    let firstMessagePreview: string | undefined;
    // Try reading state.json
    const stateFile = path.join(dir, 'state.json');
    const stateStat = safeStat(stateFile);
    if (stateStat) {
      try {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.timestamp === 'number') createdAt = data.timestamp;
        if (typeof data.model === 'string') title = data.model;
        if (typeof data.first_user_message === 'string' && data.first_user_message.trim()) {
          firstMessagePreview = trunc(data.first_user_message.trim());
        }
      } catch {
        // ignore
      }
    }
    items.push({ id: uuid, providerId: 'kimi', cwd, createdAt, updatedAt, title, firstMessagePreview });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxCount);
}

/**
 * OpenCode: shell out to `opencode session list --format json --max-count 50`,
 * filter by `directory === cwd`, return sorted DESC.
 */
async function listOpencodeSessions(
  cwd: string,
  maxCount: number,
  sinceMs: number | undefined,
  runner?: (cwd: string) => Promise<string>,
): Promise<SessionListItem[]> {
  const runOnce = runner ?? defaultOpencodeListRunner;
  let json: string;
  try {
    json = await runOnce(cwd);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [];
  const items: SessionListItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    if (!id) continue;
    const directory = typeof r.directory === 'string' ? r.directory : null;
    if (directory && directory !== cwd) continue;
    const updatedRaw = r.updated;
    let updatedAt: number;
    if (typeof updatedRaw === 'number') {
      updatedAt = updatedRaw > 1e12 ? updatedRaw : updatedRaw * 1000;
    } else if (typeof updatedRaw === 'string') {
      const p = Date.parse(updatedRaw);
      if (!Number.isFinite(p)) continue;
      updatedAt = p;
    } else {
      continue;
    }
    if (sinceMs !== undefined && sinceMs > 0 && Date.now() - updatedAt > sinceMs) continue;
    const createdAt = updatedAt; // OpenCode doesn't expose created_at
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined;
    items.push({ id, providerId: 'opencode', cwd, createdAt, updatedAt, title });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxCount);
}

async function defaultOpencodeListRunner(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'opencode',
    ['session', 'list', '--format', 'json', '--max-count', '50'],
    { cwd, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
  );
  return stdout;
}

/**
 * v1.3.0 — Returns all sessions for `providerId` associated with `cwd`,
 * sorted by `updatedAt` DESC. Unlike `findLatestSessionId`, this function:
 *   - Does NOT apply the 5-minute mtime gate (returns all historical sessions).
 *   - Returns an array of `SessionListItem`, not a single string id.
 *   - Supports `maxCount` (default 50) and optional `sinceMs` window.
 *   - Claude sessions are included; Gemini returns [] (deferred to v1.3.1).
 *
 * The existing `findLatestSessionId` is preserved unchanged for v1.2.8
 * capture-path compatibility.
 */
export async function listSessionsInCwd(
  providerId: string,
  cwd: string,
  opts: ListSessionsOptions = {},
): Promise<SessionListItem[]> {
  const homeDir = opts.homeDir ?? os.homedir();
  const maxCount = opts.maxCount ?? 50;
  const sinceMs = opts.sinceMs;
  const provider = providerId.trim().toLowerCase();
  switch (provider) {
    case 'claude':
      return listClaudeSessions(homeDir, cwd, maxCount, sinceMs);
    case 'codex':
      return listCodexSessions(homeDir, cwd, maxCount, sinceMs);
    case 'kimi':
      return listKimiSessions(homeDir, cwd, maxCount, sinceMs);
    case 'opencode':
      return listOpencodeSessions(cwd, maxCount, sinceMs, opts.runOpencodeList);
    case 'gemini':
      // Deferred to v1.3.1 — disk layout undocumented.
      return [];
    default:
      return [];
  }
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
