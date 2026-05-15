// v1.3.0 / v1.3.1 — lastResumePlan RPC controller integration test.
//
// Tests the SQL-level logic for `panes.lastResumePlan(workspaceId)` which
// reads the most-recent `agent_sessions` row per `(workspace_id, pane_index)`
// for a workspace and derives the per-pane resume plan used by SessionStep's
// Scenario B pre-population.
//
// We do NOT load `rpc-router.ts` (it has Electron/ipc imports). Instead we
// replicate the controller's query logic with a fake `getRawDb` that mirrors
// the JOIN-on-MAX(started_at) shape — same approach as
// `resume-launcher.test.ts`.
//
// v1.3.1 added the `pane_index` column (migration 0012) so the controller can
// return ONE row per pane (the most recent) instead of ROW_NUMBER-keying every
// historical row. Tests cover: empty workspace, single launch, multi-launch
// dedup (the original production regression), NULL externalSessionId,
// workspace scoping, partial NULL pane_index rows.

import { describe, expect, it } from 'vitest';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentSessionRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  provider_effective: string | null;
  cwd: string;
  status: string;
  exit_code: number | null;
  started_at: number;
  exited_at: number | null;
  external_session_id: string | null;
  pane_index: number | null;
}

// ─── Fake DB (mirrors the JOIN shape introduced by v1.3.1) ───────────────────

function buildFakeDb(rows: AgentSessionRow[]) {
  return {
    prepare(sql: string) {
      void sql; // consumed
      return {
        all(
          workspaceId: string,
          // Second positional bind for the inner subquery; the controller
          // passes the same workspaceId twice.
          workspaceIdInner?: string,
        ): Array<{ paneIndex: number; providerId: string; externalSessionId: string | null }> {
          // Replicate the v1.3.1 SQL:
          // - filter to this workspace AND non-null pane_index
          // - group by pane_index, pick MAX(started_at) per group
          // - return one row per pane, ordered by pane_index ASC
          const wsId = workspaceIdInner ?? workspaceId;
          const scoped = rows.filter(
            (r) => r.workspace_id === wsId && r.pane_index !== null,
          );
          // Group by pane_index → latest row per group.
          const latestPerPane = new Map<number, AgentSessionRow>();
          for (const r of scoped) {
            const existing = latestPerPane.get(r.pane_index as number);
            if (!existing || r.started_at > existing.started_at) {
              latestPerPane.set(r.pane_index as number, r);
            }
          }
          const ordered = [...latestPerPane.values()].sort(
            (a, b) => (a.pane_index ?? 0) - (b.pane_index ?? 0),
          );
          return ordered.map((r) => ({
            paneIndex: r.pane_index as number,
            providerId: r.provider_id,
            externalSessionId: r.external_session_id,
          }));
        },
      };
    },
  };
}

/** Mirrors the controller implementation in rpc-router.ts (v1.3.1). */
function lastResumePlan(
  db: ReturnType<typeof buildFakeDb>,
  workspaceId: string,
): Array<{ paneIndex: number; providerId: string; sessionId: string | null }> {
  try {
    const rows = db
      .prepare(
        `SELECT s.pane_index AS paneIndex, s.provider_id AS providerId,
                s.external_session_id AS externalSessionId
         FROM agent_sessions s
         INNER JOIN (
           SELECT workspace_id, pane_index, MAX(started_at) AS max_started_at
           FROM agent_sessions
           WHERE workspace_id = ? AND pane_index IS NOT NULL
           GROUP BY workspace_id, pane_index
         ) latest
           ON latest.workspace_id = s.workspace_id
           AND latest.pane_index = s.pane_index
           AND latest.max_started_at = s.started_at
         WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
         ORDER BY s.pane_index ASC`,
      )
      .all(workspaceId, workspaceId);
    return rows.map((r) => ({
      paneIndex: r.paneIndex,
      providerId: r.providerId,
      sessionId: r.externalSessionId ?? null,
    }));
  } catch {
    return [];
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let sessionCounter = 0;
function row(
  workspaceId: string,
  paneIndex: number | null,
  providerId: string,
  externalSessionId: string | null,
  startedAt: number,
): AgentSessionRow {
  sessionCounter += 1;
  return {
    id: `sess-${sessionCounter}`,
    workspace_id: workspaceId,
    provider_id: providerId,
    provider_effective: providerId,
    cwd: '/proj',
    status: 'exited',
    exit_code: 0,
    started_at: startedAt,
    exited_at: startedAt + 1000,
    external_session_id: externalSessionId,
    pane_index: paneIndex,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('lastResumePlan — pane plan derivation', () => {
  it('returns empty array for a workspace with no sessions', () => {
    const db = buildFakeDb([]);
    const result = lastResumePlan(db, 'ws-abc');
    expect(result).toEqual([]);
  });

  it('returns one entry per pane for a single launch (pane_index ASC)', () => {
    const db = buildFakeDb([
      row('ws-abc', 0, 'claude', 'ext-claude-new', 1_700_000_001_000),
      row('ws-abc', 1, 'codex', 'ext-codex-old', 1_700_000_000_000),
    ]);
    const result = lastResumePlan(db, 'ws-abc');
    expect(result).toHaveLength(2);
    // Ordered by pane_index ASC
    expect(result[0]).toEqual({ paneIndex: 0, providerId: 'claude', sessionId: 'ext-claude-new' });
    expect(result[1]).toEqual({ paneIndex: 1, providerId: 'codex', sessionId: 'ext-codex-old' });
  });

  it('maps null externalSessionId to sessionId: null', () => {
    const db = buildFakeDb([
      row('ws-xyz', 0, 'kimi', null, 1_700_000_003_000),
    ]);
    const result = lastResumePlan(db, 'ws-xyz');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ paneIndex: 0, providerId: 'kimi', sessionId: null });
  });

  it('only returns rows belonging to the queried workspaceId', () => {
    const db = buildFakeDb([
      row('ws-one', 0, 'claude', 'ext-ws-one', 1_700_000_010_000),
      row('ws-two', 0, 'codex', 'ext-ws-two', 1_700_000_012_000),
    ]);
    const resultOne = lastResumePlan(db, 'ws-one');
    const resultTwo = lastResumePlan(db, 'ws-two');
    const resultOther = lastResumePlan(db, 'ws-unknown');

    expect(resultOne).toHaveLength(1);
    expect(resultOne[0]?.sessionId).toBe('ext-ws-one');

    expect(resultTwo).toHaveLength(1);
    expect(resultTwo[0]?.sessionId).toBe('ext-ws-two');

    expect(resultOther).toEqual([]);
  });

  // v1.3.1 — the production regression. Three launches of a 4-pane workspace
  // wrote 12 rows. The pre-v1.3.1 SQL returned every row, surfacing 12 plan
  // entries → frontend `chooseExisting()` set `preset = 12` → 12+ panes
  // spawned. The fix groups by `(workspace_id, pane_index)` so only the
  // latest per pane appears.
  it('multi-launch dedup: returns only the most recent row per pane', () => {
    const db = buildFakeDb([
      // Launch 1 (oldest) — 4 panes
      row('ws-mp', 0, 'claude', 'ext-c-v1', 1_700_000_000_000),
      row('ws-mp', 1, 'codex', 'ext-x-v1', 1_700_000_000_500),
      row('ws-mp', 2, 'gemini', 'ext-g-v1', 1_700_000_001_000),
      row('ws-mp', 3, 'kimi', 'ext-k-v1', 1_700_000_001_500),
      // Launch 2 — 4 panes
      row('ws-mp', 0, 'claude', 'ext-c-v2', 1_700_000_100_000),
      row('ws-mp', 1, 'codex', 'ext-x-v2', 1_700_000_100_500),
      row('ws-mp', 2, 'gemini', 'ext-g-v2', 1_700_000_101_000),
      row('ws-mp', 3, 'kimi', 'ext-k-v2', 1_700_000_101_500),
      // Launch 3 (newest) — 4 panes
      row('ws-mp', 0, 'claude', 'ext-c-v3', 1_700_000_200_000),
      row('ws-mp', 1, 'codex', 'ext-x-v3', 1_700_000_200_500),
      row('ws-mp', 2, 'gemini', 'ext-g-v3', 1_700_000_201_000),
      row('ws-mp', 3, 'kimi', 'ext-k-v3', 1_700_000_201_500),
    ]);
    const result = lastResumePlan(db, 'ws-mp');
    // CRITICAL: 4 rows (one per pane), NOT 12.
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.paneIndex)).toEqual([0, 1, 2, 3]);
    expect(result.map((r) => r.providerId)).toEqual(['claude', 'codex', 'gemini', 'kimi']);
    // Latest sessionId per pane (v3 ids).
    expect(result.map((r) => r.sessionId)).toEqual([
      'ext-c-v3',
      'ext-x-v3',
      'ext-g-v3',
      'ext-k-v3',
    ]);
  });

  // v1.3.1 — partial history: previous launch had 4 panes, only 2 had a
  // captured external_session_id (e.g. disk-scan never fired). The picker
  // should still see all 4 panes, with sessionId: null for the two that lack
  // a captured id.
  it('partial history: null external_session_id rows still appear with sessionId: null', () => {
    const db = buildFakeDb([
      row('ws-ph', 0, 'claude', 'ext-claude', 1_700_000_300_000),
      row('ws-ph', 1, 'codex', null, 1_700_000_300_500), // no external id captured
      row('ws-ph', 2, 'gemini', null, 1_700_000_301_000), // no external id captured
      row('ws-ph', 3, 'kimi', 'ext-kimi', 1_700_000_301_500),
    ]);
    const result = lastResumePlan(db, 'ws-ph');
    expect(result).toHaveLength(4);
    expect(result[0]?.sessionId).toBe('ext-claude');
    expect(result[1]?.sessionId).toBeNull();
    expect(result[2]?.sessionId).toBeNull();
    expect(result[3]?.sessionId).toBe('ext-kimi');
  });

  // v1.3.1 — legacy rows without pane_index (pre-migration writes) must be
  // excluded so they cannot inflate the pane count.
  it('legacy rows with NULL pane_index are excluded', () => {
    const db = buildFakeDb([
      row('ws-lg', null, 'claude', 'ext-legacy-1', 1_699_999_000_000),
      row('ws-lg', null, 'codex', 'ext-legacy-2', 1_699_999_001_000),
      row('ws-lg', 0, 'claude', 'ext-modern', 1_700_000_400_000),
    ]);
    const result = lastResumePlan(db, 'ws-lg');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ paneIndex: 0, providerId: 'claude', sessionId: 'ext-modern' });
  });

  // v1.3.1 — when a re-launch swaps the provider for a pane (e.g. operator
  // assigned claude → gemini at the same pane slot), the picker should
  // surface the most-recent provider for that slot.
  it('provider swap at the same pane slot returns the newest provider', () => {
    const db = buildFakeDb([
      row('ws-sw', 0, 'claude', 'ext-c-1', 1_700_000_500_000), // old
      row('ws-sw', 0, 'gemini', 'ext-g-2', 1_700_000_600_000), // new — operator swapped
    ]);
    const result = lastResumePlan(db, 'ws-sw');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      paneIndex: 0,
      providerId: 'gemini',
      sessionId: 'ext-g-2',
    });
  });
});
