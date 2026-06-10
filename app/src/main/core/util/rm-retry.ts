// Win32-aware recursive dir removal.
//
// On Windows a dir with an open handle / a process cwd inside it fails
// `fs.rm` with EBUSY or EPERM (and a half-removed tree surfaces ENOTEMPTY).
// Handles are typically released within ms-to-s of a tree-kill, so a bounded
// retry-with-backoff converts a permanent wedge into a short wait. Non-win32
// platforms keep single-shot semantics — zero behavior change on macOS/Linux.
//
// Platform is INJECTED (never branch on raw process.platform in callers).

import { promises as fsPromises } from 'node:fs';

export const WIN32_RM_RETRY_DELAYS_MS = [100, 300, 900] as const;

const RETRYABLE_WIN32_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

export interface RmRetryDeps {
  platform?: NodeJS.Platform;
  rm?: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

/**
 * `fs.rm(p, { recursive: true, force: true })` with win32-only bounded
 * retry-with-backoff on EBUSY/EPERM/ENOTEMPTY. After the final failure a
 * warning is surfaced (so the operator sees WHY a worktree dir survived the
 * janitor) and the last error is rethrown — callers keep their fail-open
 * error counting (cleanup.ts pruneRepoDir).
 */
export async function rmDirWithRetry(p: string, deps: RmRetryDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const rm = deps.rm ?? ((target, opts) => fsPromises.rm(target, opts));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = deps.warn ?? console.warn;

  const attempts = platform === 'win32' ? WIN32_RM_RETRY_DELAYS_MS.length + 1 : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(WIN32_RM_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      await rm(p, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || !RETRYABLE_WIN32_CODES.has(code)) throw err;
    }
  }
  warn(
    `[rm-retry] win32: dir still locked after ${attempts} attempts (open handle / process cwd?):`,
    p,
    lastErr,
  );
  throw lastErr;
}
