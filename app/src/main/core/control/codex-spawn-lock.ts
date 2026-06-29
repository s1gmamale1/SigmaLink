// src/main/core/control/codex-spawn-lock.ts
//
// Per-CODEX_HOME async spawn-serialization mutex (Task 5a of the control-plane
// interactive parity plan, Unit 5).
//
// Codex uses single-use OAuth refresh tokens stored in ~/.codex/auth.json. Three
// spawn paths (boot-resume, control launch_pane, human open) can overlap and race
// that single token → "refresh token already used". A promise-chain mutex keyed
// by the resolved CODEX_HOME serializes all codex spawns so the auth dance of one
// completes before the next starts.
//
// PURE — no electron/DB/IPC. Clock/timer injected for tests. vitest-safe.

import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_HOLD_MS = 4_000;

/** Per-home promise-chain tail. Module-level so the lock persists across calls. */
const locks = new Map<string, Promise<void>>();

/**
 * Resolve the effective CODEX_HOME path.
 *
 * Preference order:
 *   1. `env.CODEX_HOME` (explicit override)
 *   2. `process.env.CODEX_HOME` (global override)
 *   3. `<os.homedir()>/.codex` (default)
 */
export function resolveCodexHome(env?: NodeJS.ProcessEnv): string {
  const envHome = env?.['CODEX_HOME'] ?? process.env['CODEX_HOME'];
  return envHome ?? path.join(os.homedir(), '.codex');
}

/**
 * Acquire a per-`home` async mutex, call `fn`, then release.
 *
 * Serialization semantics — same `home`:
 *   The second caller starts only after the first `fn` resolves/rejects OR
 *   `maxHoldMs` (default 4 s) elapses. The cap prevents a hung codex from
 *   blocking all future codex spawns indefinitely; fn continues running after
 *   a timeout release.
 *
 * Concurrency semantics — different `home`:
 *   Independent chains — always run concurrently, never block each other.
 *
 * Injected timer:
 *   `setTimer`/`clearTimer` replace `setTimeout`/`clearTimeout` so tests can
 *   drive the cap timeout with a fake clock (matching the attention-detector
 *   test pattern).
 */
export async function withCodexSpawnLock<T>(
  home: string,
  fn: () => Promise<T>,
  opts?: {
    maxHoldMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  },
): Promise<T> {
  const maxHoldMs = opts?.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const setTimer = opts?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const tail = locks.get(home) ?? Promise.resolve();

  let released = false;
  let releaseFn!: () => void;
  const slot = new Promise<void>((resolve) => {
    releaseFn = () => {
      if (!released) {
        released = true;
        resolve();
      }
    };
  });

  // Advance the chain: the next waiter for this home waits on our slot.
  locks.set(home, tail.then(() => slot));

  // Wait for our turn.
  await tail;

  // We hold the lock. Arm the cap timer so a hung fn can't block forever.
  const handle = setTimer(releaseFn, maxHoldMs);

  try {
    return await fn();
  } finally {
    clearTimer(handle);
    releaseFn();
  }
}

/** Reset all lock state. For tests only — do not call in production. */
export function _resetLocksForTest(): void {
  locks.clear();
}
