// BSP-O1 — Live swarm-level token-delta aggregator for the Sigma panel Canvas
// sub-tab. Polls `rpc.usage.sessionSummary` every 3 s for each session in the
// active swarm and sums the output-token deltas to produce a swarm-aggregate
// tok/s estimate.
//
// Design mirrors `usePaneLiveStats` (same interval, same delta derivation)
// without modifying it. Key differences:
//   - Accepts an array of sessionIds (one per swarm agent).
//   - Only polls while `enabled` (= swarm status === 'running') to avoid a
//     poll-storm on ended swarms (same PERF-5 precedent as usePaneLiveStats).
//   - Returns a single `swarmTokenDelta` (output tokens gained since the last
//     poll, summed across all sessions) and a `hasData` flag.

import { useEffect, useRef, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';

const POLL_INTERVAL_MS = 3_000;

export interface SwarmLiveStats {
  /** Sum of output-token deltas across all swarm sessions since the last poll. */
  swarmTokenDelta: number;
  /** True once at least one session has recorded a usage turn. */
  hasData: boolean;
}

const EMPTY_STATS: SwarmLiveStats = { swarmTokenDelta: 0, hasData: false };

/**
 * Aggregate live output-token delta across all agent sessions in a swarm.
 *
 * @param sessionIds - The agent_sessions ids belonging to the active swarm.
 * @param enabled    - Only poll while true (pass `swarm.status === 'running'`).
 */
export function useSwarmLiveStats(
  sessionIds: string[],
  enabled: boolean,
): SwarmLiveStats {
  const [stats, setStats] = useState<SwarmLiveStats>(EMPTY_STATS);

  // Per-session baseline refs so deltas are computed relative to the prior
  // poll. Using refs avoids re-registering the interval on each poll cycle.
  const prevOutputTokensRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!enabled || sessionIds.length === 0) {
      // Clear baselines so a future re-enable starts fresh.
      prevOutputTokensRef.current.clear();
      return;
    }

    // Reset baselines for any NEW session ids (e.g. when the swarm roster
    // changes). Sessions that disappeared are simply ignored next poll.
    const baselines = prevOutputTokensRef.current;

    let alive = true;

    async function poll(): Promise<void> {
      let totalDelta = 0;
      let anyData = false;

      await Promise.allSettled(
        sessionIds.map(async (sessionId) => {
          try {
            const summary = await rpc.usage.sessionSummary({ sessionId });
            if (!alive) return;
            if (!summary || summary.turnCount === 0) return;
            anyData = true;
            // M2 — seed the baseline on first sight WITHOUT emitting a delta.
            // Otherwise prev=0 makes the first poll report the full lifetime
            // output-token count (a huge bogus spike for resumed swarms). The
            // first displayed value is then the genuine next-poll delta.
            if (!baselines.has(sessionId)) {
              baselines.set(sessionId, summary.outputTokens);
              return;
            }
            const prev = baselines.get(sessionId) ?? 0;
            const delta = summary.outputTokens - prev;
            if (delta > 0) {
              totalDelta += delta;
            }
            baselines.set(sessionId, summary.outputTokens);
          } catch {
            // RPC failure for this session — skip silently.
          }
        }),
      );

      if (!alive) return;

      // L2 — prune baselines for sessions no longer in the roster so the map
      // doesn't grow unbounded across roster mutations within one running swarm.
      const live = new Set(sessionIds);
      for (const key of baselines.keys()) {
        if (!live.has(key)) baselines.delete(key);
      }

      setStats({ swarmTokenDelta: totalDelta, hasData: anyData });
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
    // Stringify sessionIds to produce a stable dep value for the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionIds.join(',')]);

  return enabled ? stats : EMPTY_STATS;
}
