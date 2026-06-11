// Spec 2026-06-10 (B) — stage a dropped/pasted image to a temp file so a pane
// can inject an absolute @path that image-capable CLIs (claude/codex) read
// from the prompt. Clipboard-write is upstream-broken for Claude Code (it reads
// legacy «class PNGf»; Electron writes public.png — anthropics/claude-code#30936),
// so the FILE PATH is the only path that works for both CLIs today. Boundary
// validation lives HERE (renderer input is untrusted): extension allowlist +
// size cap; the filename is fully server-generated so no path traversal is
// possible. Extracted as a pure DI-style helper (baseDir injected) because
// rpc-router itself cannot be loaded under vitest (Electron imports).
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Subdir under <userData> that holds staged screenshots. */
export const STAGED_IMAGES_DIR = 'staged-images';
/** Default janitor cutoff — staged images are transient prompt inputs. */
export const STAGED_IMAGE_MAX_AGE_MS = 7 * 86400 * 1000; // 7 days

export function stageImage(
  input: { bytesBase64: string; ext: string },
  opts: { baseDir: string },
): { absPath: string } {
  const cleanExt = String(input.ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED_EXTENSIONS.has(cleanExt)) {
    throw new Error(`stageImage: unsupported extension "${input.ext}"`);
  }
  if (typeof input.bytesBase64 !== 'string' || input.bytesBase64.length === 0) {
    throw new Error('stageImage: empty payload');
  }
  const buf = Buffer.from(input.bytesBase64, 'base64');
  if (buf.byteLength === 0) throw new Error('stageImage: empty payload');
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('stageImage: image exceeds 20MB cap');
  const dir = path.join(opts.baseDir, STAGED_IMAGES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, `sigmalink-img-${Date.now()}-${randomUUID().slice(0, 8)}.${cleanExt}`);
  fs.writeFileSync(absPath, buf);
  return { absPath };
}

export interface StagedImageSweepResult {
  /** files unlinked (older than the cutoff) */
  removed: number;
  /** files kept (younger than the cutoff) */
  kept: number;
  /** files that errored during stat/unlink; logged + ignored */
  errors: number;
}

/**
 * Boot-time janitor for the staged-images dir.
 *
 * `stageImage` writes screenshots to `<userData>/staged-images/sigmalink-img-*`
 * and never deletes them, so the dir grows unbounded across sessions (the files
 * are transient prompt inputs — once the agent has read the @path the bytes are
 * dead weight). This sweep unlinks staged images older than `maxAgeMs`, mirroring
 * the worktree-reaper / boot-sweep pattern.
 *
 * DI-style (same rationale as `stageImage`): the dir lister, file stat, unlink
 * and clock are all injectable so the sweep is unit-testable with a fake fs +
 * injected `now` (no real Date.now reliance, no `new Database()`).
 *
 * Fail-open: a missing dir returns all-zeros; a per-file stat/unlink failure
 * increments `errors` and the sweep continues. It NEVER throws — boot must not
 * be blocked.
 */
export async function sweepStagedImages(opts: {
  baseDir: string;
  maxAgeMs?: number;
  now?: number;
  deps?: {
    readdir?: (dir: string) => Promise<string[]>;
    stat?: (file: string) => Promise<{ mtimeMs: number }>;
    unlink?: (file: string) => Promise<void>;
  };
}): Promise<StagedImageSweepResult> {
  const result: StagedImageSweepResult = { removed: 0, kept: 0, errors: 0 };
  const maxAgeMs = opts.maxAgeMs ?? STAGED_IMAGE_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - maxAgeMs;
  const readdir = opts.deps?.readdir ?? ((d: string) => fsp.readdir(d));
  const stat = opts.deps?.stat ?? ((f: string) => fsp.stat(f) as Promise<{ mtimeMs: number }>);
  const unlink = opts.deps?.unlink ?? ((f: string) => fsp.unlink(f));

  const dir = path.join(opts.baseDir, STAGED_IMAGES_DIR);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // Dir doesn't exist yet (no image ever staged) — nothing to sweep.
    return result;
  }

  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (st.mtimeMs < cutoff) {
        await unlink(full);
        result.removed++;
      } else {
        result.kept++;
      }
    } catch (err) {
      // Constant format string; the path + error are args (not concatenated)
      // to avoid any format-string injection from a filename (CWE-134).
      console.warn('[stage-image] sweep failed for %s:', full, err);
      result.errors++;
    }
  }

  if (result.removed > 0 || result.errors > 0) {
    console.info(
      '[stage-image] sweep removed=%d kept=%d errors=%d',
      result.removed,
      result.kept,
      result.errors,
    );
  }

  return result;
}
