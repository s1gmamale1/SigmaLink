// Phase 4 Step 5 — SigmaSkills marketplace live install from a public GitHub
// repository.
//
// Pipeline (each phase emits an `install-progress` callback so the renderer
// can drive a progress bar):
//   1. resolve  — parse `owner/repo` shorthand or a full GitHub URL; if no
//                 ref is supplied resolve the default branch via the GitHub
//                 metadata API.
//   2. fetch    — stream the tarball at
//                 `https://api.github.com/repos/{owner}/{repo}/tarball/{ref}`
//                 to a temp file inside `tempDir`. We follow up to 5
//                 redirects and require a `User-Agent` header (GitHub rejects
//                 anonymous requests without one).
//   3. extract  — shell out to the system `tar -xzf` into a per-job
//                 subdirectory of `tempDir`. POSIX bsdtar + GNU tar both
//                 accept this flag combination; on Windows we fall back to
//                 `tar.exe` which ships with Windows 10+.
//   4. validate — locate `SKILL.md` (root, optional `subPath`, or a single
//                 `skills/<entry>/` child). Reject when no SKILL.md is found
//                 or when the existing `parseSkillMd` validator rejects the
//                 frontmatter.
//   5. ingest   — hand the folder to `manager.ingestFolder(...)`. This reuses
//                 the sha256 hash + atomic temp+rename + per-provider fan-out
//                 path that powers drag-and-drop installs.
//   6. fanout   — `ingestFolder` already handles re-fanout for enabled
//                 providers; we surface the per-provider state via the
//                 manager's normal `list()` lookup so the controller's
//                 success envelope can carry per-provider results.
//
// All filesystem state lives under `tempDir` (a callee-supplied directory —
// typically `<userData>/marketplace-tmp/`). On any failure we attempt a
// best-effort cleanup of the per-job extract dir; the tarball download itself
// is removed inline once extraction completes.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { parseSkillMd } from './frontmatter';
import type { SkillsManager } from './manager';
import type { Skill, ProviderTarget } from './types';

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export type InstallPhase =
  | 'resolve'
  | 'fetch'
  | 'extract'
  | 'validate'
  | 'ingest'
  | 'fanout'
  | 'done'
  | 'error';

export interface InstallProgressEvent {
  phase: InstallPhase;
  /** Bytes downloaded / extracted so far. 0 outside the fetch phase. */
  bytesDone: number;
  /** Total bytes the source declared. 0 when unknown. */
  bytesTotal: number;
  /** Set on `phase === 'error'`. */
  message?: string;
}

export interface InstallFromUrlOpts {
  /** `'owner/repo'` shorthand OR a full GitHub URL. Required. */
  ownerRepo: string;
  /** Optional ref (branch / tag / commit sha). Defaults to the repo's default branch. */
  ref?: string;
  /** Optional sub-path inside the repo where SKILL.md lives. */
  subPath?: string;
  /** Force re-install when an existing skill has the same name + different hash. */
  force?: boolean;
  /** Phase-by-phase progress callback. Invoked synchronously where possible. */
  onProgress?: (evt: InstallProgressEvent) => void;
}

export interface FanoutResultRow {
  provider: ProviderTarget;
  enabled: boolean;
  ok: boolean;
  reason?: string;
}

export interface InstallFromUrlResult {
  ok: boolean;
  skill?: Skill;
  /** Snapshot of the post-install per-provider state. Empty when no fanout ran. */
  fanoutResults?: FanoutResultRow[];
  error?: { code: InstallErrorCode; message: string };
}

export type InstallErrorCode =
  | 'invalid-url'
  | 'metadata-failed'
  | 'download-failed'
  | 'extract-failed'
  | 'no-skill-md'
  | 'invalid-skill'
  | 'ingest-failed'
  | 'update-required';

export interface InstallDeps {
  manager: SkillsManager;
  /** Directory used to stage tarball downloads + extractions. The installer
   *  creates a per-job subdirectory below this path. */
  tempDir: string;
  /** Override for tests — the production path uses `https.get`. */
  httpClient?: HttpClient;
  /** Override for tests — the production path shells out to `tar`. */
  extractTarball?: (tarPath: string, destDir: string) => Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// URL parsing
// ────────────────────────────────────────────────────────────────────────────

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const OWNER_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface ParsedRepoRef {
  owner: string;
  repo: string;
}

/**
 * Accept the three URL shapes the marketplace card surfaces:
 *   - `'owner/repo'` shorthand
 *   - `'https://github.com/owner/repo'` (with optional `.git` suffix and
 *     trailing `/tree/<ref>` segments — those are ignored at this layer)
 *   - `'git@github.com:owner/repo.git'` SSH shorthand
 *
 * Returns `null` when the input is unparseable so callers can surface a
 * structured `'invalid-url'` error code without throwing.
 */
export function parseRepoRef(input: string): ParsedRepoRef | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Shorthand: `owner/repo` (no scheme, single slash, no whitespace, must
  // not start with `/`).
  if (!trimmed.includes(':') && !trimmed.includes('://')) {
    if (trimmed.startsWith('/') || trimmed.endsWith('/')) return null;
    const parts = trimmed.split('/');
    if (parts.length !== 2) return null;
    if (!parts[0] || !parts[1]) return null;
    return validatePair(parts[0]!, parts[1]!);
  }

  // SSH form: `git@github.com:owner/repo.git`.
  if (trimmed.startsWith('git@')) {
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) return null;
    const host = trimmed.slice(4, colonIdx);
    if (host !== 'github.com') return null;
    const rest = trimmed.slice(colonIdx + 1);
    const parts = rest.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return validatePair(parts[0]!, parts[1]!);
  }

  // HTTPS / HTTP URL.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
    return null;
  }
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/i, '');
  return validatePair(owner, repo);
}

function validatePair(owner: string, repo: string): ParsedRepoRef | null {
  if (!OWNER_NAME_RE.test(owner)) return null;
  if (!REPO_NAME_RE.test(repo)) return null;
  return { owner, repo };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP plumbing — small, replaceable client so tests don't hit the network
// ────────────────────────────────────────────────────────────────────────────

export interface HttpClient {
  /** GET a small JSON response (used for `/repos/{owner}/{repo}` metadata). */
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  /** Stream a binary response into the destination path. Returns bytes written. */
  download(
    url: string,
    destPath: string,
    onChunk: (delta: number, total: number) => void,
    headers?: Record<string, string>,
  ): Promise<{ bytes: number }>;
}

const DEFAULT_USER_AGENT = 'SigmaLink/1.1.0-rc1';

class NodeHttpClient implements HttpClient {
  async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.requestFollowing(
        url,
        headers,
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
            return;
          }
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(raw));
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
        reject,
      );
    });
  }

  async download(
    url: string,
    destPath: string,
    onChunk: (delta: number, total: number) => void,
    headers: Record<string, string> = {},
  ): Promise<{ bytes: number }> {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      let bytes = 0;
      let total = 0;
      this.requestFollowing(
        url,
        headers,
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            out.close();
            reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
            return;
          }
          if (res.headers['content-length']) {
            const n = Number(res.headers['content-length']);
            if (Number.isFinite(n) && n > 0) total = n;
          }
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            try {
              onChunk(chunk.length, total);
            } catch {
              /* progress callback should not abort the download */
            }
          });
          res.on('error', reject);
          res.pipe(out);
          out.on('finish', () => resolve({ bytes }));
          out.on('error', reject);
        },
        reject,
      );
    });
  }

  private requestFollowing(
    url: string,
    headers: Record<string, string>,
    onResponse: (res: IncomingMessage) => void,
    onError: (err: Error) => void,
    redirectsLeft = 5,
  ): void {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'application/vnd.github+json',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            onError(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          this.requestFollowing(next, headers, onResponse, onError, redirectsLeft - 1);
          return;
        }
        onResponse(res);
      },
    );
    req.on('error', onError);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Request to ${url} timed out`));
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tarball extraction (shells out to `tar`)
// ────────────────────────────────────────────────────────────────────────────

const TAR_BIN = process.platform === 'win32' ? 'tar.exe' : 'tar';

function defaultExtractTarball(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TAR_BIN, ['-xzf', tarPath, '-C', destDir], {
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr}`));
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// SKILL.md location
// ────────────────────────────────────────────────────────────────────────────

/**
 * GitHub tarballs unwrap to a single top-level directory shaped like
 * `<owner>-<repo>-<sha7>/`. We accept that single child as the effective
 * repository root.
 */
export function findRepoRoot(extractDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) return path.join(extractDir, dirs[0]!.name);
  if (dirs.length === 0) return extractDir; // tarballs without the wrapper
  // Multiple top-level directories — fall back to the extract root and let
  // the SKILL.md walker try each common location.
  return extractDir;
}

/**
 * Probe the well-known SKILL.md locations. Order:
 *   1. `<root>/SKILL.md`
 *   2. `<root>/<subPath>/SKILL.md` (when subPath is supplied)
 *   3. `<root>/skills/<single-child>/SKILL.md` (mono-repo with one skill)
 *
 * Returns the absolute path to the *folder* containing SKILL.md, or `null`.
 */
export function locateSkillFolder(repoRoot: string, subPath?: string): string | null {
  if (subPath) {
    const candidate = path.join(repoRoot, subPath);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
    return null;
  }

  const rootSkill = path.join(repoRoot, 'SKILL.md');
  if (fs.existsSync(rootSkill)) return repoRoot;

  const skillsDir = path.join(repoRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      /* fall through */
    }
    const childDirs = dirEntries.filter((e) => e.isDirectory());
    if (childDirs.length === 1) {
      const folder = path.join(skillsDir, childDirs[0]!.name);
      if (fs.existsSync(path.join(folder, 'SKILL.md'))) return folder;
    }
    // Multiple skills under skills/<X>/ — without a subPath we can't pick.
    if (childDirs.length > 1) return null;
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────────────

function emit(
  cb: InstallFromUrlOpts['onProgress'],
  phase: InstallPhase,
  bytesDone = 0,
  bytesTotal = 0,
  message?: string,
): void {
  if (!cb) return;
  try {
    cb({ phase, bytesDone, bytesTotal, message });
  } catch {
    /* progress callbacks must never abort the pipeline */
  }
}

function safeRimraf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

async function resolveDefaultBranch(
  client: HttpClient,
  ref: ParsedRepoRef,
): Promise<string> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  const body = (await client.getJson(url)) as { default_branch?: string } | null;
  if (!body || typeof body.default_branch !== 'string' || !body.default_branch) {
    throw new Error(`Could not resolve default branch for ${ref.owner}/${ref.repo}`);
  }
  return body.default_branch;
}

export async function installFromUrl(
  deps: InstallDeps,
  opts: InstallFromUrlOpts,
): Promise<InstallFromUrlResult> {
  const client = deps.httpClient ?? new NodeHttpClient();
  const extract = deps.extractTarball ?? defaultExtractTarball;

  emit(opts.onProgress, 'resolve');

  const parsed = parseRepoRef(opts.ownerRepo);
  if (!parsed) {
    emit(opts.onProgress, 'error', 0, 0, 'Could not parse owner/repo');
    return {
      ok: false,
      error: {
        code: 'invalid-url',
        message: `Could not parse owner/repo from "${opts.ownerRepo}"`,
      },
    };
  }

  let ref: string;
  try {
    ref = opts.ref?.trim() || (await resolveDefaultBranch(client, parsed));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(opts.onProgress, 'error', 0, 0, message);
    return { ok: false, error: { code: 'metadata-failed', message } };
  }

  const jobId = randomUUID();
  fs.mkdirSync(deps.tempDir, { recursive: true });
  const jobDir = path.join(deps.tempDir, `marketplace-${jobId}`);
  const extractDir = path.join(jobDir, 'extracted');
  const tarFile = path.join(jobDir, 'tarball.tgz');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // ── fetch ─────────────────────────────────────────────────────────────
    const tarballUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${encodeURIComponent(ref)}`;
    emit(opts.onProgress, 'fetch', 0, 0);
    let totalSeen = 0;
    let bytesSeen = 0;
    try {
      const dl = await client.download(tarballUrl, tarFile, (delta, total) => {
        bytesSeen += delta;
        if (total > totalSeen) totalSeen = total;
        emit(opts.onProgress, 'fetch', bytesSeen, totalSeen);
      });
      bytesSeen = dl.bytes;
      emit(opts.onProgress, 'fetch', bytesSeen, totalSeen || bytesSeen);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(opts.onProgress, 'error', 0, 0, message);
      safeRimraf(jobDir);
      return { ok: false, error: { code: 'download-failed', message } };
    }

    // ── extract ───────────────────────────────────────────────────────────
    emit(opts.onProgress, 'extract', bytesSeen, bytesSeen);
    try {
      await extract(tarFile, extractDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(opts.onProgress, 'error', 0, 0, message);
      safeRimraf(jobDir);
      return { ok: false, error: { code: 'extract-failed', message } };
    }
    // Drop the tarball as soon as extract succeeds — frees disk on large repos.
    try {
      fs.unlinkSync(tarFile);
    } catch {
      /* best-effort */
    }

    // ── validate ──────────────────────────────────────────────────────────
    emit(opts.onProgress, 'validate', bytesSeen, bytesSeen);
    const repoRoot = findRepoRoot(extractDir);
    if (!repoRoot) {
      const message = `Tarball did not unpack into a recognisable repository root`;
      emit(opts.onProgress, 'error', 0, 0, message);
      safeRimraf(jobDir);
      return { ok: false, error: { code: 'no-skill-md', message } };
    }
    const skillFolder = locateSkillFolder(repoRoot, opts.subPath);
    if (!skillFolder) {
      const message = opts.subPath
        ? `No SKILL.md at ${opts.subPath}`
        : `No SKILL.md found at repository root or skills/<single-child>/`;
      emit(opts.onProgress, 'error', 0, 0, message);
      safeRimraf(jobDir);
      return { ok: false, error: { code: 'no-skill-md', message } };
    }
    // Pre-flight the frontmatter — surface a clean error before we copy
    // anything into the managed root.
    try {
      const text = fs.readFileSync(path.join(skillFolder, 'SKILL.md'), 'utf8');
      const fm = parseSkillMd(text, path.basename(skillFolder));
      if (!fm.ok) {
        emit(opts.onProgress, 'error', 0, 0, fm.error);
        safeRimraf(jobDir);
        return { ok: false, error: { code: 'invalid-skill', message: fm.error } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(opts.onProgress, 'error', 0, 0, message);
      safeRimraf(jobDir);
      return { ok: false, error: { code: 'invalid-skill', message } };
    }

    // ── ingest + fanout ───────────────────────────────────────────────────
    emit(opts.onProgress, 'ingest', bytesSeen, bytesSeen);
    let skill: Skill;
    try {
      skill = await deps.manager.ingestFolder(skillFolder, { force: !!opts.force });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Manager surfaces an `UPDATE_REQUIRED:<name>:<hash>` token when force
      // was not set and the skill is already installed with a different hash.
      // Pass the structured envelope back so the renderer can offer "Update".
      const code: InstallErrorCode = raw.startsWith('UPDATE_REQUIRED:')
        ? 'update-required'
        : 'ingest-failed';
      emit(opts.onProgress, 'error', 0, 0, raw);
      safeRimraf(jobDir);
      return { ok: false, error: { code, message: raw } };
    }

    emit(opts.onProgress, 'fanout', bytesSeen, bytesSeen);
    const states = deps.manager
      .list()
      .states.filter((s) => s.skillId === skill.id)
      .map<FanoutResultRow>((s) => ({
        provider: s.providerId,
        enabled: s.enabled,
        ok: !s.lastError,
        reason: s.lastError,
      }));

    emit(opts.onProgress, 'done', bytesSeen, bytesSeen);
    safeRimraf(jobDir);
    return { ok: true, skill, fanoutResults: states };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(opts.onProgress, 'error', 0, 0, message);
    safeRimraf(jobDir);
    return { ok: false, error: { code: 'ingest-failed', message } };
  }
}
