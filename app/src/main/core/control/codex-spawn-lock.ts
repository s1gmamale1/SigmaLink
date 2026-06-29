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
// Settle window: holds the slot after fn() resolves so the previous codex
// process has time to redeem its single-use OAuth refresh token before the
// next spawn begins. Set shorter than the typical token-exchange round-trip
// (which is <1 s) but long enough to absorb scheduling jitter.
const DEFAULT_SETTLE_MS = 2_500;

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
 * Acquire a per-`home` async mutex, call `fn`, then release after a settle
 * window so the next codex spawn waits until the previous one's single-use
 * OAuth token has been redeemed.
 *
 * Serialization semantics — same `home`:
 *   The second caller starts only after the first `fn` resolves/rejects AND
 *   `settleMs` (default 2 500 ms) has elapsed. The settle window ensures the
 *   previous codex process has consumed its refresh token before the next one
 *   starts. On THROW (spawn failed) the lock releases immediately with no
 *   settle — there is no auth dance to wait for.
 *
 *   An absolute `maxHoldMs` (default 4 s) cap prevents a hung fn + settle from
 *   blocking all future spawns indefinitely; fn continues running after a cap
 *   release.
 *
 * Caller receives the result of `fn` PROMPTLY — the settle delay is transparent
 * to the caller; only the NEXT waiter for the same home is deferred.
 *
 * Concurrency semantics — different `home`:
 *   Independent chains — always run concurrently, never block each other.
 *
 * Injected timer:
 *   `setTimer`/`clearTimer` replace `setTimeout`/`clearTimeout` so tests can
 *   drive the settle/cap timeouts with a fake clock (matching the attention-
 *   detector test pattern).
 */
export async function withCodexSpawnLock<T>(
  home: string,
  fn: () => Promise<T>,
  opts?: {
    maxHoldMs?: number;
    settleMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  },
): Promise<T> {
  const maxHoldMs = opts?.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
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

  // We hold the lock. Arm the absolute cap timer so a hung fn + settle cannot
  // block all future spawns indefinitely; fn continues running after a cap
  // release.
  const capHandle = setTimer(releaseFn, maxHoldMs);

  try {
    const result = await fn();
    // fn resolved successfully — clear the cap and hold the slot for settleMs
    // so the previous codex process has time to redeem its single-use refresh
    // token before the next spawn begins. The caller receives `result` promptly;
    // only the NEXT waiter is deferred by the settle window.
    clearTimer(capHandle);
    if (!released) {
      if (settleMs === 0) {
        // Zero settle: release synchronously, same as old finally behaviour.
        releaseFn();
      } else {
        setTimer(releaseFn, settleMs);
      }
    }
    return result;
  } catch (err) {
    // fn threw (spawn failed) — no auth dance to wait for; release the next
    // waiter immediately without a settle window.
    clearTimer(capHandle);
    releaseFn();
    throw err;
  }
}

/** Reset all lock state. For tests only — do not call in production. */
export function _resetLocksForTest(): void {
  locks.clear();
}
