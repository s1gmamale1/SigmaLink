// C-12 SigmaBench — harness tests. Every dependency is injected so the test
// never spawns a real swarm, touches git, or hits the DB.

import { describe, expect, it, vi } from 'vitest';
import { scoreConflicts } from '../../../shared/bench-scoring';
import { runConflictBench } from './harness';
import type { HarnessDeps, SwarmStatusSnapshot } from './harness';

interface FakeStoreState {
  created: Array<{
    runId: string;
    category: string;
    taskPrompt: string;
    providers: string[];
  }>;
  finished: Array<{ runId: string; results: unknown[]; status?: string }>;
}

function makeFakeStore(state: FakeStoreState) {
  return {
    createRun: vi.fn((_db: unknown, input: { category: string; taskPrompt: string; providers: string[] }) => {
      const runId = `run-${state.created.length + 1}`;
      state.created.push({ runId, ...input });
      return {
        id: runId,
        createdAt: 0,
        category: input.category,
        taskPrompt: input.taskPrompt,
        status: 'running' as const,
        results: input.providers.map((provider, i) => ({
          sessionId: `placeholder-${i}`,
          provider,
          changedFiles: [],
          conflictScore: null,
          exitCode: null,
        })),
      };
    }),
    finishRun: vi.fn(
      (_db: unknown, runId: string, results: unknown[], opts?: { status?: string }) => {
        state.finished.push({ runId, results, status: opts?.status });
      },
    ),
  };
}

function baseDeps(overrides: Partial<HarnessDeps> = {}): {
  deps: HarnessDeps;
  storeState: FakeStoreState;
  createSwarm: ReturnType<typeof vi.fn>;
  gitStatus: ReturnType<typeof vi.fn>;
} {
  const storeState: FakeStoreState = { created: [], finished: [] };

  // createSwarm spy — returns a swarm whose agents map provider → session +
  // worktree path. Roles are distinct (builder-1, builder-2, ...).
  const createSwarm = vi.fn(async (input: { roster: Array<{ providerId: string }> }) => {
    return {
      id: 'swarm-1',
      agents: input.roster.map((entry, i) => ({
        sessionId: `sess-${i}`,
        providerId: entry.providerId,
        worktreePath: `/wt/${entry.providerId}`,
        status: 'idle',
      })),
    };
  });

  // All agents exited immediately, each with a worktree.
  const readSwarmStatuses = vi.fn(
    async (_swarmId: string): Promise<SwarmStatusSnapshot[]> => [
      { sessionId: 'sess-0', status: 'exited', worktreePath: '/wt/claude', exitCode: 0 },
      { sessionId: 'sess-1', status: 'exited', worktreePath: '/wt/codex', exitCode: 0 },
      { sessionId: 'sess-2', status: 'exited', worktreePath: '/wt/gemini', exitCode: 0 },
    ],
  );

  // gitStatus per worktree — claude+codex share src/shared.ts; gemini disjoint.
  const gitStatus = vi.fn(async (cwd: string) => {
    const map: Record<string, { staged: string[]; unstaged: string[]; untracked: string[] }> = {
      '/wt/claude': { staged: ['src/shared.ts'], unstaged: [], untracked: ['src/a.ts'] },
      '/wt/codex': { staged: [], unstaged: ['src/shared.ts'], untracked: ['src/b.ts'] },
      '/wt/gemini': { staged: ['src/c.ts'], unstaged: [], untracked: [] },
    };
    const s = map[cwd];
    if (!s) return null;
    return { branch: 'x', ahead: 0, behind: 0, clean: false, ...s };
  });

  const deps: HarnessDeps = {
    db: {} as never,
    workspaceId: 'ws-1',
    createSwarm: createSwarm as unknown as HarnessDeps['createSwarm'],
    swarmFactoryDeps: {} as never,
    readSwarmStatuses: readSwarmStatuses as unknown as HarnessDeps['readSwarmStatuses'],
    gitStatus: gitStatus as unknown as HarnessDeps['gitStatus'],
    store: makeFakeStore(storeState) as unknown as HarnessDeps['store'],
    scoreConflicts,
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 600_000,
    tickMs: 1_500,
    ...overrides,
  };

  return {
    deps,
    storeState,
    createSwarm,
    gitStatus: gitStatus as unknown as ReturnType<typeof vi.fn>,
  };
}

describe('runConflictBench', () => {
  it('calls createSwarm once with one distinct-role roster entry per provider', async () => {
    const { deps, createSwarm } = baseDeps();
    await runConflictBench(
      { taskPrompt: 'do the thing', providers: ['claude', 'codex', 'gemini'] },
      deps,
    );

    expect(createSwarm).toHaveBeenCalledTimes(1);
    const [input] = createSwarm.mock.calls[0];
    expect(input.roster).toHaveLength(3);
    // Distinct roles (role+roleIndex pairs are unique).
    const roleKeys = input.roster.map(
      (r: { role: string; roleIndex: number }) => `${r.role}-${r.roleIndex}`,
    );
    expect(new Set(roleKeys).size).toBe(3);
    // Each provider preserved and each carries the task prompt.
    expect(input.roster.map((r: { providerId: string }) => r.providerId)).toEqual([
      'claude',
      'codex',
      'gemini',
    ]);
    for (const entry of input.roster) {
      expect(entry.initialPrompt).toBe('do the thing');
    }
  });

  it('computes conflict scores from per-worktree git status and persists', async () => {
    const { deps, storeState } = baseDeps();
    const result = await runConflictBench(
      { taskPrompt: 'task', providers: ['claude', 'codex', 'gemini'] },
      deps,
    );

    expect(storeState.created).toHaveLength(1);
    expect(storeState.created[0].category).toBe('multi-agent-conflict');
    expect(storeState.finished).toHaveLength(1);

    const byProvider = new Map(result.results.map((r) => [r.provider, r]));
    // claude + codex both touch src/shared.ts => each scores 1; gemini disjoint => 0.
    expect(byProvider.get('claude')?.conflictScore).toBe(1);
    expect(byProvider.get('codex')?.conflictScore).toBe(1);
    expect(byProvider.get('gemini')?.conflictScore).toBe(0);
    // changedFiles unions staged + unstaged + untracked.
    expect(byProvider.get('claude')?.changedFiles.sort()).toEqual(
      ['src/a.ts', 'src/shared.ts'].sort(),
    );
    expect(result.runId).toBe(storeState.created[0].runId);
  });

  it('polls until all agents have exited/errored', async () => {
    let poll = 0;
    const readSwarmStatuses = vi.fn(async (): Promise<SwarmStatusSnapshot[]> => {
      poll += 1;
      const done = poll >= 3;
      return [
        {
          sessionId: 'sess-0',
          status: done ? 'exited' : 'running',
          worktreePath: '/wt/claude',
          exitCode: done ? 0 : null,
        },
      ];
    });
    const { deps } = baseDeps({
      readSwarmStatuses: readSwarmStatuses as unknown as HarnessDeps['readSwarmStatuses'],
    });
    await runConflictBench({ taskPrompt: 't', providers: ['claude'] }, deps);
    expect(poll).toBeGreaterThanOrEqual(3);
  });

  it('skips gitStatus for an agent that errored before producing a worktree', async () => {
    const readSwarmStatuses = vi.fn(async (): Promise<SwarmStatusSnapshot[]> => [
      { sessionId: 'sess-0', status: 'exited', worktreePath: '/wt/claude', exitCode: 0 },
      // codex errored with NO worktree.
      { sessionId: 'sess-1', status: 'error', worktreePath: null, exitCode: 1 },
    ]);
    const { deps, gitStatus } = baseDeps({
      readSwarmStatuses: readSwarmStatuses as unknown as HarnessDeps['readSwarmStatuses'],
    });
    const result = await runConflictBench(
      { taskPrompt: 't', providers: ['claude', 'codex'] },
      deps,
    );

    // gitStatus called for claude's worktree but NOT for the errored codex.
    const calledPaths = gitStatus.mock.calls.map((c) => c[0]);
    expect(calledPaths).toContain('/wt/claude');
    expect(calledPaths).not.toContain(null);
    expect(calledPaths).not.toContain('/wt/codex');

    // The errored agent still appears in results, marked with its changed
    // files empty and the exit code from the snapshot.
    const codex = result.results.find((r) => r.provider === 'codex');
    expect(codex?.changedFiles).toEqual([]);
    expect(codex?.exitCode).toBe(1);
  });

  it('never throws when gitStatus rejects for one agent — that result is marked', async () => {
    const gitStatus = vi.fn(async (cwd: string) => {
      if (cwd === '/wt/codex') throw new Error('git blew up');
      return { branch: 'x', ahead: 0, behind: 0, clean: false, staged: ['src/a.ts'], unstaged: [], untracked: [] };
    });
    const readSwarmStatuses = vi.fn(async (): Promise<SwarmStatusSnapshot[]> => [
      { sessionId: 'sess-0', status: 'exited', worktreePath: '/wt/claude', exitCode: 0 },
      { sessionId: 'sess-1', status: 'exited', worktreePath: '/wt/codex', exitCode: 0 },
    ]);
    const { deps } = baseDeps({
      gitStatus: gitStatus as unknown as HarnessDeps['gitStatus'],
      readSwarmStatuses: readSwarmStatuses as unknown as HarnessDeps['readSwarmStatuses'],
    });
    const result = await runConflictBench(
      { taskPrompt: 't', providers: ['claude', 'codex'] },
      deps,
    );
    const codex = result.results.find((r) => r.provider === 'codex');
    expect(codex?.changedFiles).toEqual([]);
  });

  it('bails out of the poll loop on timeout and still finishes the run', async () => {
    // Never exits; the harness must give up once now() exceeds timeoutMs.
    let t = 0;
    const readSwarmStatuses = vi.fn(async (): Promise<SwarmStatusSnapshot[]> => [
      { sessionId: 'sess-0', status: 'running', worktreePath: '/wt/claude', exitCode: null },
    ]);
    const { deps, storeState } = baseDeps({
      readSwarmStatuses: readSwarmStatuses as unknown as HarnessDeps['readSwarmStatuses'],
      now: () => {
        t += 200_000;
        return t;
      },
      timeoutMs: 600_000,
    });
    const result = await runConflictBench({ taskPrompt: 't', providers: ['claude'] }, deps);
    expect(storeState.finished).toHaveLength(1);
    expect(result.runId).toBeTruthy();
  });
});
