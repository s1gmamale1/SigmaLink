// perf-hot-paths Task 2 — ONE shared, visibility-paused 3 s poller per
// sessionId for the pane-header live-stats badge (usePaneLiveStats) + the
// Sigma panel swarm aggregate (useSwarmLiveStats). Replaces the per-pane
// independent setInterval (2 RPCs / pane / 3 s with NO document.hidden
// pause) and dedupes a pane + the swarm panel watching the SAME session into
// one RPC pair per tick. Uses rpcSilent so a failing poll degrades quietly
// (a 3 s loop must never toast-storm).

import { useCallback, useSyncExternalStore } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { createSharedPoller } from '@/renderer/lib/shared-poll';
import type { UsageSummary } from '@/shared/types';

export interface ProcessStatsNode {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
  args: string;
}

export interface ProcessStatsResponse {
  supported: boolean;
  rssBytes: number;
  processCount: number;
  nodes?: ProcessStatsNode[];
}

export interface SessionStatsSnapshot {
  summary: UsageSummary | null;
  processStats: ProcessStatsResponse | null;
  /** Timestamp of this poll — drives tok/s delta math in consumers. */
  polledAt: number;
}

export const SESSION_STATS_INTERVAL_MS = 3_000;

export const sessionStatsPoller = createSharedPoller<SessionStatsSnapshot>({
  intervalMs: SESSION_STATS_INTERVAL_MS,
  // NO staggerPhase: consumers derive tok/s from inter-poll deltas and rely
  // on a steady 3 s cadence; the expensive half (ps) is TTL-cached in main.
  fetch: async (sessionId) => {
    const [summaryRes, statsRes] = await Promise.allSettled([
      rpcSilent.usage.sessionSummary({ sessionId }),
      rpcSilent.pty.processStats(sessionId),
    ]);
    return {
      summary: summaryRes.status === 'fulfilled' ? (summaryRes.value as UsageSummary) : null,
      processStats:
        statsRes.status === 'fulfilled' ? (statsRes.value as ProcessStatsResponse) : null,
      polledAt: Date.now(),
    };
  },
});

const EMPTY_UNSUBSCRIBE = (): void => undefined;

/**
 * Live `{summary, processStats, polledAt}` for a session. Pass `null` to
 * disable — the PERF-5 status gate: callers pass the id only while
 * `session.status === 'running'`, so exited/error panes never subscribe.
 */
export function useSessionStatsPoll(sessionId: string | null): SessionStatsSnapshot | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      sessionId ? sessionStatsPoller.subscribe(sessionId, onStoreChange) : EMPTY_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? sessionStatsPoller.getSnapshot(sessionId) : null),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only helper. */
export function __resetSessionStatsPoller(): void {
  sessionStatsPoller.__reset();
}
