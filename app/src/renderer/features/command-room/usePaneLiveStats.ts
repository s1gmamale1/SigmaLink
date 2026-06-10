// BSP-V2 + perf-hot-paths Task 2 — live per-pane cost + tok/s estimate.
//
// The pane no longer owns a poll loop: it subscribes to the SHARED
// visibility-paused 3 s session-stats poller (use-session-stats-poll.ts) and
// derives the tok/s ESTIMATE from successive shared snapshots (output-token
// delta ÷ polledAt delta; always labelled "~" — the CLI only reports tokens
// at turn-end, not mid-stream). N components watching the same session share
// ONE RPC pair per tick; NOTHING polls while the window is hidden; exited/
// error panes pass enabled=false and never subscribe (PERF-5 status gate,
// mirrors PaneFooter.tsx:91).

import { useEffect, useRef, useState } from 'react';
import {
  useSessionStatsPoll,
  type ProcessStatsNode,
  type ProcessStatsResponse,
} from '@/renderer/lib/use-session-stats-poll';

/** Minimum elapsed seconds before we emit a tok/s estimate (avoids div/0 or
 *  wildly inaccurate bursts at startup). */
const MIN_ELAPSED_S = 1;

export interface PaneLiveStats {
  /** Total USD cost from the usage ledger; null when no priced turn yet. */
  totalCostUsd: number | null;
  /** Estimated output tokens per second ("~" label required). null when not
   *  enough data to estimate (< 2 polls or < MIN_ELAPSED_S elapsed). */
  estTokPerSec: number | null;
  /** True when at least one usage turn has been recorded (turnCount > 0). */
  hasData: boolean;
  /** Process-tree RSS in bytes; null when unsupported or unavailable. */
  rssBytes: number | null;
  /** Number of processes in the pane tree; null when unsupported or unavailable. */
  processCount: number | null;
  /** RSS for the root CLI process in bytes; null when unavailable. */
  rootRssBytes: number | null;
  /** RSS for MCP-like child processes in bytes; null when unavailable. */
  mcpRssBytes: number | null;
  /** Highest-RSS child command, useful for spotting MCP/npm/node inflation. */
  topChildCommand: string | null;
}

const EMPTY_STATS: PaneLiveStats = {
  totalCostUsd: null,
  estTokPerSec: null,
  hasData: false,
  rssBytes: null,
  processCount: null,
  rootRssBytes: null,
  mcpRssBytes: null,
  topChildCommand: null,
};

/**
 * Live cost + tok/s + RSS for a pane. Shape and gating semantics are
 * unchanged from the pre-Task-2 hook (PaneHeader.tsx:108 consumes as-is).
 */
export function usePaneLiveStats(sessionId: string, enabled: boolean): PaneLiveStats {
  const snap = useSessionStatsPoll(enabled ? sessionId : null);
  const [stats, setStats] = useState<PaneLiveStats>(EMPTY_STATS);
  const prevRef = useRef<{ outputTokens: number; polledAt: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Reset the delta baseline so a future re-enable starts clean.
      prevRef.current = null;
      return;
    }
    if (!snap) return;

    let alive = true;
    const commit = (next: PaneLiveStats | ((prev: PaneLiveStats) => PaneLiveStats)): void => {
      queueMicrotask(() => {
        if (alive) setStats(next);
      });
    };

    const { summary, processStats, polledAt } = snap;
    const rssBytes =
      processStats?.supported && processStats.rssBytes > 0 ? processStats.rssBytes : null;
    const processCount =
      processStats?.supported && processStats.processCount > 0
        ? processStats.processCount
        : null;
    const rssBreakdown = computeRssBreakdown(processStats);

    if (!summary) {
      // Usage RPC failed this tick: keep RSS fresh, retain prior usage fields.
      commit((prev) => ({ ...prev, rssBytes, processCount, ...rssBreakdown }));
      return () => {
        alive = false;
      };
    }
    if (summary.turnCount === 0) {
      prevRef.current = null;
      commit({ ...EMPTY_STATS, rssBytes, processCount, ...rssBreakdown });
      return () => {
        alive = false;
      };
    }

    const prev = prevRef.current;
    let estTokPerSec: number | null = null;
    if (prev) {
      const elapsedS = (polledAt - prev.polledAt) / 1_000;
      const tokenDelta = summary.outputTokens - prev.outputTokens;
      if (elapsedS >= MIN_ELAPSED_S && tokenDelta > 0) {
        estTokPerSec = Math.round((tokenDelta / elapsedS) * 10) / 10;
      }
    }
    prevRef.current = { outputTokens: summary.outputTokens, polledAt };

    commit({
      totalCostUsd: summary.totalCostUsd,
      estTokPerSec,
      hasData: true,
      rssBytes,
      processCount,
      ...rssBreakdown,
    });

    return () => {
      alive = false;
    };
  }, [snap, enabled]);

  return enabled ? stats : EMPTY_STATS;
}

function computeRssBreakdown(
  processStats: ProcessStatsResponse | null,
): Pick<PaneLiveStats, 'rootRssBytes' | 'mcpRssBytes' | 'topChildCommand'> {
  if (!processStats?.supported || !processStats.nodes?.length) {
    return { rootRssBytes: null, mcpRssBytes: null, topChildCommand: null };
  }
  const root = processStats.nodes[0];
  const children = processStats.nodes.filter((node) => node.pid !== root.pid);
  const mcpRssBytes = children
    .filter((node) => /mcp|ruflo|claude-flow|context7/i.test(`${node.command} ${node.args}`))
    .reduce((sum, node) => sum + node.rssBytes, 0);
  const topChild = children.reduce<ProcessStatsNode | null>(
    (top, node) => (!top || node.rssBytes > top.rssBytes ? node : top),
    null,
  );
  return {
    rootRssBytes: root.rssBytes > 0 ? root.rssBytes : null,
    mcpRssBytes: mcpRssBytes > 0 ? mcpRssBytes : null,
    topChildCommand: topChild?.command || null,
  };
}
