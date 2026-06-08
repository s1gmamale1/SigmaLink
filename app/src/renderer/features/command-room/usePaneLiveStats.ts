// BSP-V2 — live per-pane cost + tok/s estimate.
//
// Polls `rpc.usage.sessionSummary` every ~3 s for the given sessionId and
// computes a tok/s ESTIMATE (output tokens ÷ elapsed seconds, labelled "~"
// because the CLI only reports tokens at turn-end, not mid-stream).
//
// Design decisions:
//   - `outputTokens` is the accumulated post-hoc count; we compare it across
//     polls to derive a delta and divide by the elapsed interval. The result is
//     an ESTIMATE and is always labelled "~".
//   - Hide the badge when `turnCount === 0` (no usage recorded yet — common for
//     non-Claude panes or freshly spawned panes).
//   - Reduced-motion safety: this hook only returns data; the badge component is
//     responsible for motion-safe rendering.
//   - The poller is mount-bound and stops on unmount (no memory leak).
//   - STATUS-GATED (PERF-5 precedent, mirrors PaneFooter.tsx:91): the caller
//     passes `enabled` (= `session.status === 'running'`). When `!enabled` we do
//     NOT create the interval (and clear any existing one) and return the empty
//     shape — exited/error panes have a frozen ledger, so polling them forever is
//     a pointless poll-storm.

import { useEffect, useRef, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { UsageSummary } from '@/shared/types';

/** Interval between polls in milliseconds. */
const POLL_INTERVAL_MS = 3_000;

/** Minimum elapsed seconds before we emit a tok/s estimate (avoids div/0 or wildly
 *  inaccurate bursts at startup). */
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

interface ProcessStatsNode {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
  args: string;
}

interface ProcessStatsResponse {
  supported: boolean;
  rssBytes: number;
  processCount: number;
  nodes?: ProcessStatsNode[];
}

/**
 * Poll `rpc.usage.sessionSummary` every ~3 s for a pane's live cost + tok/s
 * estimate. Returns `{ hasData: false }` until the first turn is recorded.
 *
 * @param sessionId — the pane's agent_sessions id.
 * @param enabled — only poll while true (caller passes `session.status === 'running'`).
 *   When false, the interval is never created (and any existing one is cleared)
 *   and the empty shape is returned so the badge hides. Mirrors PaneFooter's
 *   status-gated interval (PERF-5 poll-storm precedent).
 */
export function usePaneLiveStats(sessionId: string, enabled: boolean): PaneLiveStats {
  const [stats, setStats] = useState<PaneLiveStats>(EMPTY_STATS);

  // Track the previous poll's output token count + timestamp for delta-based
  // tok/s estimation. Use refs so the interval closure always sees the latest
  // values without re-registering the interval. Both are initialised inside
  // useEffect (not at render time) to avoid `Date.now()` purity lint warnings.
  const prevOutputTokensRef = useRef<number>(0);
  const prevPollTimeRef = useRef<number>(0);

  useEffect(() => {
    // Status gate (PERF-5): do NOT poll non-running panes. The cleanup from a
    // prior `enabled` render has already cleared any interval; returning early
    // here means no new interval is created (mirrors PaneFooter.tsx:91). We do
    // NOT call setState in the effect body (react-hooks/set-state-in-effect) —
    // instead the hook derives the empty shape below when `!enabled`, so the
    // badge hides the instant a pane transitions running → exited/error.
    if (!enabled) {
      // Reset the delta baselines so a future re-enable starts clean. Refs are
      // not reactive state, so writing them here is fine.
      prevOutputTokensRef.current = 0;
      prevPollTimeRef.current = 0;
      return;
    }

    let alive = true;
    // Initialise the baseline inside the effect so Date.now() is not called
    // during render (react-hooks/purity lint rule).
    prevPollTimeRef.current = Date.now();

    async function poll(): Promise<void> {
      let summary: UsageSummary | null = null;
      let processStats: ProcessStatsResponse | null = null;
      try {
        summary = await rpc.usage.sessionSummary({ sessionId });
      } catch {
        // Usage RPC failure: keep RSS polling alive.
      }
      try {
        processStats = await rpc.pty.processStats(sessionId);
      } catch {
        processStats = null;
      }
      if (!alive) return;

      const rssBytes =
        processStats?.supported && processStats.rssBytes > 0 ? processStats.rssBytes : null;
      const processCount =
        processStats?.supported && processStats.processCount > 0 ? processStats.processCount : null;
      const rssBreakdown = computeRssBreakdown(processStats);

      if (!summary) {
        setStats((prev) => ({ ...prev, rssBytes, processCount, ...rssBreakdown }));
        return;
      }

      const hasData = summary.turnCount > 0;
      if (!hasData) {
        // No turns recorded yet — emit empty state, reset baselines.
        prevOutputTokensRef.current = 0;
        prevPollTimeRef.current = Date.now();
        setStats({ ...EMPTY_STATS, rssBytes, processCount, ...rssBreakdown });
        return;
      }

      const now = Date.now();
      const elapsedS = (now - prevPollTimeRef.current) / 1_000;
      const tokenDelta = summary.outputTokens - prevOutputTokensRef.current;

      let estTokPerSec: number | null = null;
      if (elapsedS >= MIN_ELAPSED_S && tokenDelta > 0) {
        // Round to 1 decimal for display.
        estTokPerSec = Math.round((tokenDelta / elapsedS) * 10) / 10;
      }

      prevOutputTokensRef.current = summary.outputTokens;
      prevPollTimeRef.current = now;

      setStats({
        totalCostUsd: summary.totalCostUsd,
        estTokPerSec,
        hasData: true,
        rssBytes,
        processCount,
        ...rssBreakdown,
      });
    }

    // Immediate first poll so the badge appears quickly after mount.
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, enabled]);

  // When disabled (non-running pane), derive the empty shape so the badge hides
  // immediately — without a setState-in-effect. `stats` may still hold the last
  // polled values from when the pane was running; gating the return here is the
  // single source of truth for "should this pane show live stats".
  return enabled ? stats : EMPTY_STATS;
}

function computeRssBreakdown(processStats: ProcessStatsResponse | null): Pick<
  PaneLiveStats,
  'rootRssBytes' | 'mcpRssBytes' | 'topChildCommand'
> {
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
