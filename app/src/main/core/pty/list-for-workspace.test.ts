// v1.4.3 (#02) — listForWorkspace RPC controller integration test.
//
// Tests the SQL-level logic for `panes.listForWorkspace(workspaceId)` which
// returns ONE full AgentSession row per pane slot (live first, then newest,
// then id DESC) for the renderer's ADD_SESSIONS dispatch path.
//
// We do NOT load `rpc-router.ts` (it has Electron/ipc imports). We replicate
// the query logic with a fake `getRawDb` — same approach as
// `last-resume-plan.test.ts`.

import { describe, expect, it } from 'vitest';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RawSessionRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  runtime_profile_id: string | null;
  cwd: string;
  branch: string | null;
  worktree_path: string | null;
  status: string;
  exit_code: number | null;
  initial_prompt: string | null;
  started_at: number;
  exited_at: number | null;
  pane_index: number | null;
}

// ─── Fake DB ─────────────────────────────────────────────────────────────────

function buildFakeDb(rows: RawSessionRow[]) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    prepare(_sql: string) {
      return {
        all(workspaceId: string, workspaceIdInner?: string) {
          const wsId = workspaceIdInner ?? workspaceId;
          const scoped = rows.filter(
            (r) => r.workspace_id === wsId && r.pane_index !== null,
          );
          // Group by pane_index → deterministic owner per group.
          const latestPerPane = new Map<number, RawSessionRow>();
          for (const r of scoped) {
            const existing = latestPerPane.get(r.pane_index as number);
            if (!existing || compareSlotOwner(r, existing) < 0) {
              latestPerPane.set(r.pane_index as number, r);
            }
          }
          // Order by pane_index ASC.
          return [...latestPerPane.values()].sort(
            (a, b) => (a.pane_index ?? 0) - (b.pane_index ?? 0),
          );
        },
      };
    },
  };
}

function liveRank(r: RawSessionRow): number {
  return r.status === 'running' || r.status === 'starting' ? 0 : 1;
}

function compareSlotOwner(a: RawSessionRow, b: RawSessionRow): number {
  const liveDelta = liveRank(a) - liveRank(b);
  if (liveDelta !== 0) return liveDelta;
  const startedDelta = b.started_at - a.started_at;
  if (startedDelta !== 0) return startedDelta;
  return b.id.localeCompare(a.id);
}

/** Mirrors the listForWorkspace controller implementation in rpc-router.ts. */
function listForWorkspace(
  db: ReturnType<typeof buildFakeDb>,
  workspaceId: string,
) {
  try {
    const rows = db.prepare('SELECT ...').all(workspaceId, workspaceId) as RawSessionRow[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      providerId: r.provider_id,
      runtimeProfileId: r.runtime_profile_id ?? 'ruflo-core',
      cwd: r.cwd,
      branch: r.branch ?? null,
      worktreePath: r.worktree_path ?? null,
      status: r.status as 'starting' | 'running' | 'exited' | 'error',
      exitCode: r.exit_code ?? undefined,
      startedAt: r.started_at,
      exitedAt: r.exited_at ?? undefined,
      initialPrompt: r.initial_prompt ?? undefined,
    }));
  } catch {
    return [];
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let counter = 0;
function row(
  workspaceId: string,
  paneIndex: number | null,
  providerId: string,
  startedAt: number,
  status = 'exited',
): RawSessionRow {
  counter++;
  return {
    id: `sess-${counter.toString().padStart(4, '0')}`,
    workspace_id: workspaceId,
    provider_id: providerId,
    runtime_profile_id: providerId === 'claude' ? 'browser-tools' : null,
    cwd: `/tmp/${workspaceId}`,
    branch: null,
    worktree_path: null,
    status,
    exit_code: 0,
    initial_prompt: null,
    started_at: startedAt,
    exited_at: startedAt + 1000,
    pane_index: paneIndex,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('panes.listForWorkspace — full AgentSession rehydration', () => {
  it('returns empty array for a fresh workspace with no sessions', () => {
    const db = buildFakeDb([]);
    const result = listForWorkspace(db, 'ws-fresh');
    expect(result).toEqual([]);
  });

  it('returns one full AgentSession per unique pane_index, even with DB duplicates (started_at wins after live rank)', () => {
    const db = buildFakeDb([
      row('ws-A', 0, 'claude', 1000),  // older
      row('ws-A', 0, 'claude', 2000),  // newer — this one should win
    ]);
    const result = listForWorkspace(db, 'ws-A');
    expect(result).toHaveLength(1);
    expect(result[0]?.startedAt).toBe(2000);
  });

  it('prefers a live row over a newer exited row for the same pane slot', () => {
    const db = buildFakeDb([
      row('ws-live', 0, 'claude', 1000, 'running'),
      row('ws-live', 0, 'gemini', 2000, 'exited'),
    ]);
    const result = listForWorkspace(db, 'ws-live');
    expect(result).toHaveLength(1);
    expect(result[0]?.providerId).toBe('claude');
    expect(result[0]?.status).toBe('running');
  });

  it('uses id DESC to break started_at ties so one slot returns one row', () => {
    const db = buildFakeDb([
      { ...row('ws-tie', 0, 'claude', 1000, 'running'), id: 'sess-a' },
      { ...row('ws-tie', 0, 'codex', 1000, 'running'), id: 'sess-z' },
    ]);
    const result = listForWorkspace(db, 'ws-tie');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('sess-z');
    expect(result[0]?.providerId).toBe('codex');
  });

  it('filters by workspaceId correctly — other workspace rows excluded', () => {
    const db = buildFakeDb([
      row('ws-B', 0, 'codex', 1000),
      row('ws-C', 0, 'gemini', 1000),
    ]);
    const resultB = listForWorkspace(db, 'ws-B');
    const resultC = listForWorkspace(db, 'ws-C');
    const resultOther = listForWorkspace(db, 'ws-unknown');

    expect(resultB).toHaveLength(1);
    expect(resultB[0]?.providerId).toBe('codex');

    expect(resultC).toHaveLength(1);
    expect(resultC[0]?.providerId).toBe('gemini');

    expect(resultOther).toEqual([]);
  });

  it('excludes rows with pane_index IS NULL', () => {
    const db = buildFakeDb([
      row('ws-D', null, 'claude', 1000),   // legacy row — excluded
      row('ws-D', 0, 'codex', 2000),         // modern row — included
    ]);
    const result = listForWorkspace(db, 'ws-D');
    expect(result).toHaveLength(1);
    expect(result[0]?.providerId).toBe('codex');
  });

  it('orders results by pane_index ASC', () => {
    const db = buildFakeDb([
      row('ws-E', 3, 'kimi', 1000),
      row('ws-E', 1, 'codex', 1000),
      row('ws-E', 0, 'claude', 1000),
      row('ws-E', 2, 'gemini', 1000),
    ]);
    const result = listForWorkspace(db, 'ws-E');
    expect(result.map((r) => r.providerId)).toEqual(['claude', 'codex', 'gemini', 'kimi']);
  });

  it('maps full AgentSession fields correctly including optional fields', () => {
    const db = buildFakeDb([
      {
        id: 'explicit-id',
        workspace_id: 'ws-F',
        provider_id: 'claude',
        runtime_profile_id: 'security-tools',
        cwd: '/tmp/ws-F',
        branch: 'sigmalink/claude/pane-0',
        worktree_path: '/worktrees/abc/claude-pane-0-x1y2z3',
        status: 'exited',
        exit_code: 0,
        initial_prompt: 'Hello world',
        started_at: 5000,
        exited_at: 6000,
        pane_index: 0,
      },
    ]);
    const result = listForWorkspace(db, 'ws-F');
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.id).toBe('explicit-id');
    expect(s.workspaceId).toBe('ws-F');
    expect(s.providerId).toBe('claude');
    expect(s.runtimeProfileId).toBe('security-tools');
    expect(s.cwd).toBe('/tmp/ws-F');
    expect(s.branch).toBe('sigmalink/claude/pane-0');
    expect(s.worktreePath).toBe('/worktrees/abc/claude-pane-0-x1y2z3');
    expect(s.status).toBe('exited');
    expect(s.exitCode).toBe(0);
    expect(s.startedAt).toBe(5000);
    expect(s.exitedAt).toBe(6000);
    expect(s.initialPrompt).toBe('Hello world');
  });
});
