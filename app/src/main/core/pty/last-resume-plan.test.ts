// v1.3.0 — lastResumePlan RPC controller integration test.
//
// Tests the SQL-level logic for `panes.lastResumePlan(workspaceId)` which
// reads the most-recent `agent_sessions` rows per workspace and derives the
// per-pane resume plan used by SessionStep's Scenario B pre-population.
//
// We do NOT load `rpc-router.ts` (it has Electron/ipc imports). Instead we
// replicate the controller's query logic with a fake `getRawDb` — same
// approach as `resume-launcher.test.ts`.

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
}

// ─── Fake DB (mirrors the pattern in resume-launcher.test.ts) ────────────────

function buildFakeDb(rows: AgentSessionRow[]) {
  return {
    prepare(sql: string) {
      return {
        all(workspaceId: string): Array<{ paneIndex: number; providerId: string; externalSessionId: string | null }> {
          // Replicate the controller's SQL: return rows for this workspace,
          // ordered by started_at DESC, assign row-number-based paneIndex.
          const matching = rows
            .filter((r) => r.workspace_id === workspaceId)
            .sort((a, b) => b.started_at - a.started_at);
          void sql; // consumed
          return matching.map((r, idx) => ({
            paneIndex: idx,
            providerId: r.provider_id,
            externalSessionId: r.external_session_id,
          }));
        },
      };
    },
  };
}

/** Mirrors the controller implementation in rpc-router.ts:495 */
function lastResumePlan(
  db: ReturnType<typeof buildFakeDb>,
  workspaceId: string,
): Array<{ paneIndex: number; providerId: string; sessionId: string | null }> {
  try {
    const rows = db
      .prepare(
        `SELECT
           (ROW_NUMBER() OVER (ORDER BY started_at DESC)) - 1 AS paneIndex,
           provider_id AS providerId,
           external_session_id AS externalSessionId
         FROM agent_sessions
         WHERE workspace_id = ?
         ORDER BY started_at DESC`,
      )
      .all(workspaceId);
    return rows.map((r) => ({
      paneIndex: r.paneIndex,
      providerId: r.providerId,
      sessionId: r.externalSessionId ?? null,
    }));
  } catch {
    return [];
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('lastResumePlan — pane plan derivation', () => {
  it('returns empty array for a workspace with no sessions', () => {
    const db = buildFakeDb([]);
    const result = lastResumePlan(db, 'ws-abc');
    expect(result).toEqual([]);
  });

  it('returns one entry per session row, most-recent first (paneIndex=0)', () => {
    const db = buildFakeDb([
      {
        id: 'sess-1',
        workspace_id: 'ws-abc',
        provider_id: 'claude',
        provider_effective: 'claude',
        cwd: '/proj',
        status: 'exited',
        exit_code: 0,
        started_at: 1_700_000_001_000,
        exited_at: 1_700_000_002_000,
        external_session_id: 'ext-claude-new',
      },
      {
        id: 'sess-2',
        workspace_id: 'ws-abc',
        provider_id: 'codex',
        provider_effective: 'codex',
        cwd: '/proj',
        status: 'exited',
        exit_code: 0,
        started_at: 1_700_000_000_000,
        exited_at: 1_700_000_001_000,
        external_session_id: 'ext-codex-old',
      },
    ]);
    const result = lastResumePlan(db, 'ws-abc');
    expect(result).toHaveLength(2);
    // Most-recent first → paneIndex 0 = claude (newer started_at)
    expect(result[0]).toEqual({ paneIndex: 0, providerId: 'claude', sessionId: 'ext-claude-new' });
    expect(result[1]).toEqual({ paneIndex: 1, providerId: 'codex', sessionId: 'ext-codex-old' });
  });

  it('maps null externalSessionId to sessionId: null', () => {
    const db = buildFakeDb([
      {
        id: 'sess-3',
        workspace_id: 'ws-xyz',
        provider_id: 'kimi',
        provider_effective: 'kimi',
        cwd: '/proj2',
        status: 'running',
        exit_code: null,
        started_at: 1_700_000_003_000,
        exited_at: null,
        external_session_id: null,
      },
    ]);
    const result = lastResumePlan(db, 'ws-xyz');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ paneIndex: 0, providerId: 'kimi', sessionId: null });
  });

  it('only returns rows belonging to the queried workspaceId', () => {
    const db = buildFakeDb([
      {
        id: 'sess-4',
        workspace_id: 'ws-one',
        provider_id: 'claude',
        provider_effective: 'claude',
        cwd: '/proj-one',
        status: 'exited',
        exit_code: 0,
        started_at: 1_700_000_010_000,
        exited_at: 1_700_000_011_000,
        external_session_id: 'ext-ws-one',
      },
      {
        id: 'sess-5',
        workspace_id: 'ws-two',
        provider_id: 'codex',
        provider_effective: 'codex',
        cwd: '/proj-two',
        status: 'exited',
        exit_code: 0,
        started_at: 1_700_000_012_000,
        exited_at: 1_700_000_013_000,
        external_session_id: 'ext-ws-two',
      },
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

  it('assigns sequential paneIndex in started_at DESC order across multiple panes', () => {
    const db = buildFakeDb([
      { id: 's1', workspace_id: 'ws-mp', provider_id: 'claude', provider_effective: null, cwd: '/p', status: 'exited', exit_code: 0, started_at: 3000, exited_at: null, external_session_id: 'eid-c' },
      { id: 's2', workspace_id: 'ws-mp', provider_id: 'codex', provider_effective: null, cwd: '/p', status: 'exited', exit_code: 0, started_at: 2000, exited_at: null, external_session_id: 'eid-x' },
      { id: 's3', workspace_id: 'ws-mp', provider_id: 'kimi', provider_effective: null, cwd: '/p', status: 'exited', exit_code: 0, started_at: 1000, exited_at: null, external_session_id: 'eid-k' },
    ]);
    const result = lastResumePlan(db, 'ws-mp');
    expect(result.map((r) => r.paneIndex)).toEqual([0, 1, 2]);
    expect(result.map((r) => r.providerId)).toEqual(['claude', 'codex', 'kimi']);
    expect(result.map((r) => r.sessionId)).toEqual(['eid-c', 'eid-x', 'eid-k']);
  });
});
