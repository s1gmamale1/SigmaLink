// P6 FEAT-8 + perf-hot-paths Task 2 — refcounted shared per-worktree
// git-activity poller, now riding the generic shared-poll factory (refcount,
// 60 s cadence, visibility pause, overlap guard, per-key phase stagger so N
// worktrees don't burst their commit-history walks simultaneously).

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { createSharedPoller } from '@/renderer/lib/shared-poll';
import type { GitActivityBucket } from '@/shared/types';

const POLL_INTERVAL_MS = 60_000;

const poller = createSharedPoller<GitActivityBucket[] | null>({
  intervalMs: POLL_INTERVAL_MS,
  staggerPhase: true,
  fetch: (worktreePath) => rpcSilent.git.activityLog(worktreePath),
});

const EMPTY_UNSUBSCRIBE = (): void => undefined;
const EMPTY_BUCKETS: GitActivityBucket[] = [];

/**
 * Shared git-activity poll for a worktree path. N strips on the same path
 * share ONE 60 s poll; polling pauses while the window is hidden and
 * refreshes immediately when it becomes visible. Pass `null` to disable.
 * Never throws — a failing poll retains the last good value.
 */
export function useGitActivityPoll(worktreePath: string | null): GitActivityBucket[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      worktreePath ? poller.subscribe(worktreePath, onStoreChange) : EMPTY_UNSUBSCRIBE,
    [worktreePath],
  );
  const getSnapshot = useCallback(
    () => (worktreePath ? poller.getSnapshot(worktreePath) : null),
    [worktreePath],
  );
  const buckets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return buckets ?? EMPTY_BUCKETS;
}

/** Test-only helper. */
export function __resetGitActivityPollers(): void {
  poller.__reset();
}
