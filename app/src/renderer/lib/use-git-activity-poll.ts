// P6 FEAT-8 — refcounted shared per-worktree git-activity poller.
//
// Clones the PERF-6 shape in `use-git-status-poll.ts`: a module-level singleton
// keyed by the worktree path runs ONE poll per path and fans the resolved
// `GitActivityBucket[] | null` out to every subscribing strip (refcount). The
// interval is created on the first subscriber for a path and torn down when the
// last one leaves.
//
// The activity log traverses commit history (heavier than `git status`), so it
// polls on a slower 60 s cadence rather than the status poller's 15 s.
//
// Visibility-pause: while `document.hidden` is true the intervals are suspended
// (no background git churn when the window is occluded); on becoming visible
// every active poller fires an immediate refresh and re-arms. A single shared
// `visibilitychange` listener drives this for all pollers, installed lazily on
// the first subscribe.
//
// `rpcSilent` is used so a failing poll degrades quietly (no global toast); the
// last good value is retained until the next successful poll.

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import type { GitActivityBucket } from '@/shared/types';

const POLL_INTERVAL_MS = 60_000;

type GitActivityListener = (buckets: GitActivityBucket[] | null) => void;

interface PollerEntry {
  subscribers: Set<GitActivityListener>;
  intervalId: ReturnType<typeof setInterval> | null;
  /** Most recent resolved value — seeds late subscribers without a full tick. */
  last: GitActivityBucket[] | null;
  /** Has at least one poll resolved? Distinguishes "no data yet" (null) from a
   *  genuinely empty history (also null) for late subscribers. */
  resolvedOnce: boolean;
  /** Bumped on teardown so an in-flight poll for a dead entry drops its result. */
  generation: number;
}

const pollers = new Map<string, PollerEntry>();

let visibilityListenerInstalled = false;

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function emit(entry: PollerEntry, buckets: GitActivityBucket[] | null): void {
  entry.last = buckets;
  entry.resolvedOnce = true;
  // Snapshot before dispatch so a subscriber that unsubscribes itself during
  // notification doesn't mutate the set we're iterating (mirrors status poller).
  for (const fn of Array.from(entry.subscribers)) fn(buckets);
}

async function pollWorktree(worktreePath: string, entry: PollerEntry): Promise<void> {
  const gen = entry.generation;
  try {
    const buckets = await rpcSilent.git.activityLog(worktreePath);
    // Entry may have been torn down (last subscriber left) while the RPC was in
    // flight — drop the stale result rather than emitting into nobody.
    if (entry.generation !== gen || entry.subscribers.size === 0) return;
    emit(entry, buckets);
  } catch {
    // Degrade quietly: keep the last good value, just mark that we attempted.
    if (entry.generation !== gen || entry.subscribers.size === 0) return;
    entry.resolvedOnce = true;
  }
}

function armInterval(worktreePath: string, entry: PollerEntry): void {
  if (entry.intervalId != null) return; // already armed
  if (docHidden()) return; // visibility-paused — armed on visibilitychange
  entry.intervalId = setInterval(() => {
    void pollWorktree(worktreePath, entry);
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
  for (const [worktreePath, entry] of pollers.entries()) {
    if (entry.subscribers.size === 0) continue;
    void pollWorktree(worktreePath, entry);
    armInterval(worktreePath, entry);
  }
}

function installVisibilityListenerOnce(): void {
  if (visibilityListenerInstalled) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityListenerInstalled = true;
}

/**
 * Subscribe to the shared per-worktree git-activity poller. Returns an
 * unsubscribe function. The interval is created on the first subscriber for a
 * path and torn down when the last one leaves. The listener is a bare
 * invalidation callback (`useSyncExternalStore` re-reads the snapshot on notify).
 */
function subscribeGitActivity(worktreePath: string, fn: GitActivityListener): () => void {
  installVisibilityListenerOnce();

  let entry = pollers.get(worktreePath);
  if (!entry) {
    entry = {
      subscribers: new Set(),
      intervalId: null,
      last: null,
      resolvedOnce: false,
      generation: 0,
    };
    pollers.set(worktreePath, entry);
  }
  const wasEmpty = entry.subscribers.size === 0;
  entry.subscribers.add(fn);

  if (wasEmpty) {
    // First subscriber for this path — bump generation (ignore any stray
    // in-flight poll from a prior cycle), poll immediately (unless hidden),
    // and arm the interval.
    entry.generation += 1;
    if (!docHidden()) void pollWorktree(worktreePath, entry);
    armInterval(worktreePath, entry);
  }

  const captured = entry;
  return () => {
    captured.subscribers.delete(fn);
    if (captured.subscribers.size === 0) {
      clearIntervalFor(captured);
      captured.generation += 1;
      pollers.delete(worktreePath);
    }
  };
}

/** Current cached buckets for a worktree path (the external-store snapshot). */
function getActivitySnapshot(worktreePath: string | null): GitActivityBucket[] | null {
  if (!worktreePath) return null;
  return pollers.get(worktreePath)?.last ?? null;
}

const EMPTY_UNSUBSCRIBE = (): void => undefined;
const EMPTY_BUCKETS: GitActivityBucket[] = [];

/**
 * Shared git-activity poll for a worktree path. Returns the live
 * `GitActivityBucket[]` (empty array until the first poll resolves or when
 * there's no activity) via `useSyncExternalStore`. N strips on the same path
 * share ONE 60 s poll; polling pauses while the window is hidden and refreshes
 * immediately when it becomes visible. Pass `null` to disable (e.g. a pane with
 * no worktree). Never throws — a failing poll retains the last good value.
 */
export function useGitActivityPoll(worktreePath: string | null): GitActivityBucket[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!worktreePath) return EMPTY_UNSUBSCRIBE;
      return subscribeGitActivity(worktreePath, onStoreChange);
    },
    [worktreePath],
  );
  const getSnapshot = useCallback(() => getActivitySnapshot(worktreePath), [worktreePath]);
  // `useSyncExternalStore` requires a stable snapshot identity between renders
  // when nothing changed; the cached array reference is stable, and the `null`
  // case is normalized to a shared frozen empty array.
  const buckets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return buckets ?? EMPTY_BUCKETS;
}

/**
 * Test-only helper. Resets the module-level poller singleton + the shared
 * visibility listener between tests. Not referenced by any production path.
 */
export function __resetGitActivityPollers(): void {
  for (const entry of pollers.values()) clearIntervalFor(entry);
  pollers.clear();
  if (visibilityListenerInstalled && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  visibilityListenerInstalled = false;
}
