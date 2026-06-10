// perf-hot-paths Task 4 — cached async login-shell PATH bootstrap.
//
// BUG-V1.1-03-PROV background: a DMG-launched app gets the truncated
// NSWorkspace PATH, so provider CLIs under /opt/homebrew/bin etc. ENOENT.
// The original fix spawned the user's login shell SYNCHRONOUSLY inside
// whenReady (3 s timeout) BEFORE registerRouter()+createWindow() — +200 ms
// to 1.5 s of cold-boot wall time on heavy zsh configs.
//
// New flow (darwin packaged only; win/linux/dev are exact no-ops):
//   1. Apply the previously-cached merged PATH synchronously (instant).
//   2. Resolve the live login-shell PATH ASYNC; merge + persist when it lands.
//   3. Window creation never waits. Only PTY-spawn paths await
//      `whenShellPathReady()` (≤3.5 s cap) — on a warm boot that resolves
//      immediately; on a true first run the FIRST spawn waits for the live
//      resolve so `node-pty.spawn('claude', …)` can't ENOENT.
//
// NOTE on "cache in KV": the kv SQLite table only becomes safely available
// after registerRouter() opens/migrates the DB, which is exactly the phase
// this bootstrap must precede. The caller injects a userData JSON-file cache
// instead — same persistence, zero DB coupling at boot (see electron/main.ts).
//
// No electron imports here — everything is injected so vitest can cover it.

import { execFile } from 'node:child_process';

export interface ShellPathDeps {
  platform: NodeJS.Platform;
  isDev: boolean;
  shell: string;
  pathDelimiter: string;
  /** Read the cached shell PATH (string) or null. Must be fast + sync. */
  readCache: () => string | null;
  /** Persist the freshly-resolved shell PATH. Best-effort. */
  writeCache: (shellPath: string) => void;
  getEnvPath: () => string;
  setEnvPath: (next: string) => void;
  /** Injectable for tests; defaults to the real login-shell exec. */
  resolveShellPath?: (shell: string, timeoutMs: number) => Promise<string | null>;
  timeoutMs?: number;
}

/**
 * Dedup-merge two PATH strings, shell-resolved entries first (so
 * /opt/homebrew/bin wins over a truncated /usr/bin shim). Pure.
 */
export function mergeShellPath(fromShell: string, existing: string, delimiter: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...fromShell.split(delimiter), ...existing.split(delimiter)]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(delimiter);
}

/**
 * Default resolver: `-i` (interactive) so .zshrc is sourced, `-l` (login) so
 * /etc/profile + ~/.zprofile run, `-c` to evaluate one statement and exit.
 * TERM=dumb prevents prompt-theme work. Resolves null on any failure.
 */
export function defaultResolveShellPath(shell: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', 'printf %s "$PATH"'],
      { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null);
        resolve(stdout.trim());
      },
    );
  });
}

let readyPromise: Promise<void> | null = null;

/**
 * Start the bootstrap. Returns the BACKGROUND refresh completion promise
 * (await it in tests). Readiness for spawn-gating is exposed separately via
 * `whenShellPathReady()`:
 *   - warm boot (cache hit) → ready immediately;
 *   - cold boot (no cache)  → ready when the live resolve settles.
 */
export function startShellPathBootstrap(deps: ShellPathDeps): Promise<void> {
  if (deps.platform !== 'darwin' || deps.isDev) {
    readyPromise = Promise.resolve();
    return readyPromise;
  }

  let cacheHit = false;
  try {
    const cached = deps.readCache();
    if (cached) {
      deps.setEnvPath(mergeShellPath(cached, deps.getEnvPath(), deps.pathDelimiter));
      cacheHit = true;
    }
  } catch {
    /* unreadable cache = cold path */
  }

  const resolveFn = deps.resolveShellPath ?? defaultResolveShellPath;
  const refresh = resolveFn(deps.shell, deps.timeoutMs ?? 3_000)
    .then((shellPath) => {
      if (!shellPath) return;
      deps.setEnvPath(mergeShellPath(shellPath, deps.getEnvPath(), deps.pathDelimiter));
      try {
        deps.writeCache(shellPath);
      } catch {
        /* cache write is best-effort */
      }
    })
    .catch(() => undefined);

  readyPromise = cacheHit ? Promise.resolve() : refresh;
  return refresh;
}

/**
 * Await PATH readiness before a PTY spawn, capped at `timeoutMs` so a hung
 * login shell can never deadlock spawning. Resolves immediately when the
 * bootstrap never ran (win/linux/dev/tests) or already settled.
 */
export function whenShellPathReady(timeoutMs = 3_500): Promise<void> {
  if (!readyPromise) return Promise.resolve();
  const ready = readyPromise;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    // unref so a pending gate can't hold the process open at quit.
    (timer as { unref?: () => void }).unref?.();
    void ready.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Test-only. */
export function __resetShellPathForTests(): void {
  readyPromise = null;
}
