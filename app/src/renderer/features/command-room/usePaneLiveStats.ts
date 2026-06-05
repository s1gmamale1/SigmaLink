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
}

const EMPTY_STATS: PaneLiveStats = {
  totalCostUsd: null,
  estTokPerSec: null,
  hasData: false,
};

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
      let summary: UsageSummary;
      try {
        summary = await rpc.usage.sessionSummary({ sessionId });
      } catch {
        // RPC failure: leave existing stats unchanged.
        return;
      }
      if (!alive) return;

      const hasData = summary.turnCount > 0;
      if (!hasData) {
        // No turns recorded yet — emit empty state, reset baselines.
        prevOutputTokensRef.current = 0;
        prevPollTimeRef.current = Date.now();
        setStats(EMPTY_STATS);
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
