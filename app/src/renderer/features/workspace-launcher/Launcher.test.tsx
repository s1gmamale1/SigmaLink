// v1.3.1 — Launcher payload-construction tests.
//
// Focused unit tests for `buildPaneResumePlanArray` — the helper that
// translates the SessionStep's `paneResumePlan` record into the top-level
// `LaunchPlan.paneResumePlan` array shape the backend expects.
//
// Bug B regression guard: v1.3.0 placed `sessionId` inside each `panes[i]`
// object instead of building the top-level array. `executeLaunchPlan` reads
// `plan.paneResumePlan?.find((r) => r.paneIndex === pane.paneIndex)` — when
// the array was missing, every pane spawned fresh. These tests pin the
// contract so a future refactor can't silently revert it.

import { describe, expect, it } from 'vitest';
import { buildPaneResumePlanArray } from './Launcher';

describe('buildPaneResumePlanArray — Bug B regression guard', () => {
  it('returns an empty array when no panes have selections', () => {
    const result = buildPaneResumePlanArray(4, {});
    expect(result).toEqual([]);
  });

  it('returns an empty array when every pane is set to null (New session)', () => {
    const result = buildPaneResumePlanArray(4, { 0: null, 1: null, 2: null, 3: null });
    expect(result).toEqual([]);
  });

  it('includes only panes with a non-null sessionId', () => {
    const result = buildPaneResumePlanArray(4, {
      0: 'sess-claude',
      1: null,
      2: 'sess-gemini',
      3: null,
    });
    expect(result).toEqual([
      { paneIndex: 0, sessionId: 'sess-claude' },
      { paneIndex: 2, sessionId: 'sess-gemini' },
    ]);
  });

  it('emits the entries as a top-level array (NOT inside each pane)', () => {
    const result = buildPaneResumePlanArray(2, { 0: 'a', 1: 'b' });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty('paneIndex');
    expect(result[0]).toHaveProperty('sessionId');
    expect(result[1]).toHaveProperty('paneIndex');
    expect(result[1]).toHaveProperty('sessionId');
  });

  it('respects paneCount: out-of-range selections are dropped', () => {
    // Operator selected sessions for 4 panes, then changed preset down to 2.
    // The helper must clamp to the new pane count so we don't send stale ids.
    const result = buildPaneResumePlanArray(2, {
      0: 'sess-0',
      1: 'sess-1',
      2: 'sess-2-stale',
      3: 'sess-3-stale',
    });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.paneIndex)).toEqual([0, 1]);
  });

  it('does not include undefined-key panes (user never visited SessionStep)', () => {
    // Skip-agents flow: the user clicks Launch directly from AgentsStep.
    // `paneResumePlan` stays at `{}`. The helper should return empty so the
    // backend spawns fresh and never injects resume args.
    const result = buildPaneResumePlanArray(4, {});
    expect(result).toEqual([]);
  });

  // Production-bug reproduction: the user picked 4 sessions, hit Launch, and
  // every pane spawned fresh because the helper output never landed on the
  // top-level plan. This test pins the exact shape the backend reads.
  it('matches the shape `executeLaunchPlan` reads via `paneResumePlan.find()`', () => {
    const result = buildPaneResumePlanArray(4, {
      0: 'claude-uuid',
      1: 'codex-uuid',
      2: 'gemini-uuid',
      3: 'kimi-uuid',
    });
    // Mirror the launcher.ts lookup: `plan.paneResumePlan?.find(r => r.paneIndex === pane.paneIndex)`
    expect(result.find((r) => r.paneIndex === 0)?.sessionId).toBe('claude-uuid');
    expect(result.find((r) => r.paneIndex === 1)?.sessionId).toBe('codex-uuid');
    expect(result.find((r) => r.paneIndex === 2)?.sessionId).toBe('gemini-uuid');
    expect(result.find((r) => r.paneIndex === 3)?.sessionId).toBe('kimi-uuid');
  });
});
