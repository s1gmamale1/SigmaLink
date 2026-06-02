// PERF-6 (P5 Lane Poll) — refcounted shared per-repo git-status poller.
//
// Before: every <PaneShell> ran its own `setTimeout` loop calling
// `rpc.git.status(worktreePath)` every ~15 s. Multiple panes on the SAME repo
// (worktree path) each spawned an independent poll → N identical git-status
// RPCs per repo per tick. After: a module-level singleton keyed by the repo
// path runs ONE 15 s poll per repo and fans the resolved `GitStatus | null`
// out to every subscribing pane (refcount). The interval is created on the
// first subscriber for a path and torn down when the last subscriber leaves.
// Mirrors the refcount/fan-out pattern in `src/renderer/lib/pty-data-bus.ts`.
//
// Visibility-pause: while `document.hidden` is true the per-repo intervals are
// suspended (no background git churn when the window is occluded). On the
// window becoming visible again every active poller fires an immediate refresh
// and re-arms its interval. A single shared `visibilitychange` listener drives
// this for all pollers and is installed lazily on the first subscribe.
//
// `rpcSilent` is used so a failing poll degrades quietly (no global toast); the
// last good value is retained until the next successful poll.

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import type { GitStatus } from '@/shared/types';

const POLL_INTERVAL_MS = 15_000;

type GitStatusListener = (status: GitStatus | null) => void;

interface PollerEntry {
  subscribers: Set<GitStatusListener>;
  intervalId: ReturnType<typeof setInterval> | null;
  /** Most recent resolved value — seeds late subscribers without a full tick. */
  last: GitStatus | null;
  /** Has at least one poll resolved? Distinguishes "no data yet" (null) from a
   *  genuinely clean/absent repo (also null) so a late subscriber doesn't get a
   *  misleading committed-count of 0 before the first poll lands. */
  resolvedOnce: boolean;
  /** Bumped on teardown so an in-flight poll for a dead entry drops its result. */
  generation: number;
}

const pollers = new Map<string, PollerEntry>();

let visibilityListenerInstalled = false;

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function emit(entry: PollerEntry, status: GitStatus | null): void {
  entry.last = status;
  entry.resolvedOnce = true;
  // Snapshot before dispatch so a subscriber that unsubscribes itself during
  // notification doesn't mutate the set we're iterating (mirrors pty-data-bus).
  for (const fn of Array.from(entry.subscribers)) fn(status);
}

async function pollRepo(repoPath: string, entry: PollerEntry): Promise<void> {
  const gen = entry.generation;
  try {
    const status = await rpcSilent.git.status(repoPath);
    // Entry may have been torn down (last subscriber left) while the RPC was in
    // flight — drop the stale result rather than emitting into nobody.
    if (entry.generation !== gen || entry.subscribers.size === 0) return;
    emit(entry, status);
  } catch {
    // Degrade quietly: keep the last good value, just mark that we attempted.
    if (entry.generation !== gen || entry.subscribers.size === 0) return;
    entry.resolvedOnce = true;
  }
}

function armInterval(repoPath: string, entry: PollerEntry): void {
  if (entry.intervalId != null) return; // already armed
  if (docHidden()) return; // visibility-paused — armed on visibilitychange
  entry.intervalId = setInterval(() => {
    void pollRepo(repoPath, entry);
  }, POLL_INTERVAL_MS);
}

function clearIntervalFor(entry: PollerEntry): void {
  if (entry.intervalId != null) {
    clearInterval(entry.intervalId);
    entry.intervalId = null;
  }
}

function handleVisibilityChange(): void {
  if (docHidden()) {
    // Going hidden — suspend every active interval (cheap re-arm on return).
    for (const entry of pollers.values()) clearIntervalFor(entry);
    return;
  }
  // Becoming visible — immediate refresh + re-arm for every active poller.
  for (const [repoPath, entry] of pollers.entries()) {
    if (entry.subscribers.size === 0) continue;
    void pollRepo(repoPath, entry);
    armInterval(repoPath, entry);
  }
}

function installVisibilityListenerOnce(): void {
  if (visibilityListenerInstalled) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityListenerInstalled = true;
}

/**
 * Subscribe to the shared per-repo git-status poller. Returns an unsubscribe
 * function. The interval is created on the first subscriber for a path and torn
 * down when the last one leaves. The listener is a bare invalidation callback
 * (React's `useSyncExternalStore` re-reads the snapshot on notify).
 */
function subscribeGitStatus(repoPath: string, fn: GitStatusListener): () => void {
  installVisibilityListenerOnce();

  let entry = pollers.get(repoPath);
  if (!entry) {
    entry = {
      subscribers: new Set(),
      intervalId: null,
      last: null,
      resolvedOnce: false,
      generation: 0,
    };
    pollers.set(repoPath, entry);
  }
  const wasEmpty = entry.subscribers.size === 0;
  entry.subscribers.add(fn);

  if (wasEmpty) {
    // First subscriber for this repo — bump generation (ignore any stray
    // in-flight poll from a prior cycle), poll immediately (unless hidden),
    // and arm the interval.
    entry.generation += 1;
    if (!docHidden()) void pollRepo(repoPath, entry);
    armInterval(repoPath, entry);
  }

  const captured = entry;
  return () => {
    captured.subscribers.delete(fn);
    if (captured.subscribers.size === 0) {
      clearIntervalFor(captured);
      captured.generation += 1;
      pollers.delete(repoPath);
    }
  };
}

/** Current cached status for a repo path (the external-store snapshot). */
function getGitSnapshot(repoPath: string | null | undefined): GitStatus | null {
  if (!repoPath) return null;
  return pollers.get(repoPath)?.last ?? null;
}

const EMPTY_UNSUBSCRIBE = (): void => undefined;

/**
 * Shared git-status poll for a repo (worktree) path. Returns the live
 * `GitStatus | null` via `useSyncExternalStore`. N panes on the same `repoPath`
 * share ONE 15 s poll; polling pauses while the window is hidden and refreshes
 * immediately when it becomes visible. Pass `null`/`undefined` to disable
 * (e.g. a pane with no worktree). Never throws — a failing poll retains the
 * last good value.
 */
export function useGitStatusPoll(repoPath: string | null | undefined): GitStatus | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!repoPath) return EMPTY_UNSUBSCRIBE;
      return subscribeGitStatus(repoPath, onStoreChange);
    },
    [repoPath],
  );
  const getSnapshot = useCallback(() => getGitSnapshot(repoPath), [repoPath]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Convenience derived hook for the pane header: the count of uncommitted
 * changes (staged + unstaged + untracked) for a repo path, or `null` when the
 * path is absent or the repo status is unavailable. Preserves the exact
 * `number | null` shape PaneShell consumed from its inline poll.
 */
export function useUncommittedCount(repoPath: string | null | undefined): number | null {
  const status = useGitStatusPoll(repoPath);
  if (!status) return null;
  return status.staged.length + status.unstaged.length + status.untracked.length;
}

/**
 * Test-only helper. Resets the module-level poller singleton + the shared
 * visibility listener between tests. Not referenced by any production path.
 */
export function __resetGitStatusPollers(): void {
  for (const entry of pollers.values()) clearIntervalFor(entry);
  pollers.clear();
  if (visibilityListenerInstalled && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  visibilityListenerInstalled = false;
}
