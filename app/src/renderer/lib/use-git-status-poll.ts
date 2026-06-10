// PERF-6 + perf-hot-paths Task 3 — refcounted shared per-repo COUNT-ONLY
// git-status poller for PaneShell's uncommitted badge (PaneShell.tsx:114).
//
// History: PERF-6 deduped N same-repo panes onto one 15 s `git.status` poll.
// But worktree-per-pane defeats per-repoPath dedupe (every pane = a distinct
// key), and the badge consumes ONLY a count while git.status spawned 4 git
// procs and shipped full staged/unstaged/untracked filename arrays per poll.
// Now: `git.statusSummary` (ONE git proc, 2-field payload) on the generic
// shared-poll factory, with per-key phase stagger so 20 worktree panes don't
// land 20 git spawns in one synchronized burst.
//
// The full-status `useGitStatusPoll` hook was deleted — it had NO production
// consumers (one-shot callers use rpc.git.status directly). Re-add on top of
// the factory if a live full-status subscriber ever appears.

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { createSharedPoller } from '@/renderer/lib/shared-poll';
import type { GitStatusSummary } from '@/shared/types';

const POLL_INTERVAL_MS = 15_000;

const poller = createSharedPoller<GitStatusSummary | null>({
  intervalMs: POLL_INTERVAL_MS,
  staggerPhase: true,
  fetch: (repoPath) => rpcSilent.git.statusSummary(repoPath),
});

const EMPTY_UNSUBSCRIBE = (): void => undefined;

/**
 * Count of uncommitted changes (staged + unstaged + untracked) for a repo
 * path, or `null` when the path is absent or the repo status is unavailable.
 * Preserves the exact `number | null` shape PaneShell has always consumed.
 * N panes on the same `repoPath` share ONE 15 s poll; polling pauses while
 * the window is hidden. Never throws.
 */
export function useUncommittedCount(repoPath: string | null | undefined): number | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      repoPath ? poller.subscribe(repoPath, onStoreChange) : EMPTY_UNSUBSCRIBE,
    [repoPath],
  );
  const getSnapshot = useCallback(
    () => (repoPath ? poller.getSnapshot(repoPath) : null),
    [repoPath],
  );
  const summary = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return summary ? summary.uncommitted : null;
}

/** Test-only helper. */
export function __resetGitStatusPollers(): void {
  poller.__reset();
}
