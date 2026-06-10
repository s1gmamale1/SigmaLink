// BSP-O1 + perf-hot-paths Task 2 — swarm-level token-delta aggregator for the
// Sigma panel Canvas sub-tab. No own RPC loop anymore: each swarm session is
// subscribed on the SHARED session-stats poller (dedupes with any PaneHeader
// watching the same session; pauses while the window is hidden) and
// per-session output-token deltas are accumulated, emitting once per
// notification burst via a microtask coalesce. M2 (seed without a lifetime
// spike) and L2 (roster prune) semantics preserved.

import { useEffect, useRef, useState } from 'react';
import { sessionStatsPoller } from '@/renderer/lib/use-session-stats-poll';

export interface SwarmLiveStats {
  /** Sum of output-token deltas across all swarm sessions since each
   *  session's previous poll. */
  swarmTokenDelta: number;
  /** True once at least one session has recorded a usage turn. */
  hasData: boolean;
}

const EMPTY_STATS: SwarmLiveStats = { swarmTokenDelta: 0, hasData: false };

/**
 * Aggregate live output-token delta across all agent sessions in a swarm.
 *
 * @param sessionIds - The agent_sessions ids belonging to the active swarm.
 * @param enabled    - Only subscribe while true (pass `swarm.status === 'running'`).
 */
export function useSwarmLiveStats(sessionIds: string[], enabled: boolean): SwarmLiveStats {
  const [stats, setStats] = useState<SwarmLiveStats>(EMPTY_STATS);
  // Baselines persist across roster changes within one running swarm (M2/L2).
  const baselinesRef = useRef<Map<string, number>>(new Map());

  // Stable dep value for the array identity.
  const idsKey = sessionIds.join(',');

  useEffect(() => {
    if (!enabled || idsKey === '') {
      baselinesRef.current.clear();
      return;
    }
    const ids = idsKey.split(',').filter(Boolean);
    const baselines = baselinesRef.current;
    // L2 — prune baselines for sessions no longer in the roster.
    const live = new Set(ids);
    for (const key of baselines.keys()) {
      if (!live.has(key)) baselines.delete(key);
    }

    const deltas = new Map<string, number>();
    let hasData = false;
    let scheduled = false;
    let alive = true;

    const emit = (): void => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!alive) return;
        let total = 0;
        for (const d of deltas.values()) total += d;
        setStats({ swarmTokenDelta: total, hasData });
      });
    };

    const onUpdate = (id: string): void => {
      const summary = sessionStatsPoller.getSnapshot(id)?.summary;
      if (!summary || summary.turnCount === 0) return;
      hasData = true;
      const base = baselines.get(id);
      baselines.set(id, summary.outputTokens);
      if (base === undefined) {
        // M2 — seed WITHOUT emitting a delta: prev=0 would report the full
        // lifetime output-token count (a huge bogus spike for resumed swarms).
        emit();
        return;
      }
      const delta = summary.outputTokens - base;
      if (delta > 0) deltas.set(id, delta);
      else deltas.delete(id);
      emit();
    };

    const unsubs = ids.map((id) => sessionStatsPoller.subscribe(id, () => onUpdate(id)));

    return () => {
      alive = false;
      unsubs.forEach((off) => off());
    };
  }, [enabled, idsKey]);

  return enabled ? stats : EMPTY_STATS;
}
