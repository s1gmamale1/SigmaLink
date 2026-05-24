// C-12 SigmaBench — conflict-bench harness.
//
// Dispatches the SAME task prompt to N providers, each in its own isolated
// git worktree (one swarm, N roster entries with distinct roles), waits for
// every agent to exit, reads each worktree's changed-file set, scores the
// pairwise overlap (scoreConflicts), and persists the result. This benchmarks
// the core SigmaLink thesis: distinct worktrees → near-zero merge conflicts.
//
// EVERY collaborator is injected via `HarnessDeps` so the harness is unit
// testable with no real swarm / git / DB. Production wires the real
// implementations (createSwarm + swarm-factory deps, gitStatus, the store).
//
// The poll loop is bounded: it ticks every `tickMs` until all agents have
// exited/errored OR `timeoutMs` elapses (default 10 min). Per-agent git reads
// are individually try/caught so one bad worktree never aborts the whole run.

import type Database from 'better-sqlite3';
import type { CreateSwarmInput, GitStatus, Role, Swarm } from '../../../shared/types';
import type { SwarmFactoryDeps } from '../swarms/factory';
import type { ConflictScore } from '../../../shared/bench-scoring';
import type { BenchResult, BenchRun, CreateRunInput, FinishResult } from './store';

/** A point-in-time view of one swarm agent, as the poll loop sees it. */
export interface SwarmStatusSnapshot {
  sessionId: string;
  /** Lifecycle status; `exited`/`error` are terminal. */
  status: string;
  /** The agent's worktree, or null if it errored before one was allocated. */
  worktreePath: string | null;
  exitCode: number | null;
}

/** Roster entry the harness builds — extends RoleAssignment with a prompt. */
export interface BenchRosterEntry {
  role: Role;
  roleIndex: number;
  providerId: string;
  initialPrompt: string;
}

export interface RunConflictBenchInput {
  taskPrompt: string;
  providers: string[];
  /** Defaults to 'multi-agent-conflict'. */
  category?: string;
  /** Workspace the swarm runs in; falls back to deps.workspaceId. */
  workspaceId?: string;
}

export interface RunConflictBenchResult {
  runId: string;
  results: BenchResult[];
}

/** Minimal store surface the harness needs (subset of ./store). */
export interface BenchStore {
  createRun: (db: Database.Database, input: CreateRunInput) => BenchRun;
  finishRun: (
    db: Database.Database,
    runId: string,
    results: FinishResult[],
    opts?: { status?: 'running' | 'done' | 'error' },
  ) => void;
}

export interface HarnessDeps {
  db: Database.Database;
  workspaceId: string;
  /** Materialises one worktree-isolated agent per roster entry. */
  createSwarm: (input: CreateSwarmInput, deps: SwarmFactoryDeps) => Promise<Swarm>;
  swarmFactoryDeps: SwarmFactoryDeps;
  /** Poll the live status of every agent in the swarm. */
  readSwarmStatuses: (swarmId: string) => Promise<SwarmStatusSnapshot[]>;
  /** Read a worktree's working-tree status. */
  gitStatus: (cwd: string) => Promise<GitStatus | null>;
  store: BenchStore;
  scoreConflicts: (panes: { sessionId: string; changedFiles: string[] }[]) => ConflictScore[];
  /** Injectable clock (ms). */
  now: () => number;
  /** Injectable delay between polls. */
  sleep: (ms: number) => Promise<void>;
  /** Hard ceiling for the poll loop. Default 10 minutes. */
  timeoutMs: number;
  /** Poll interval. Default 1.5s. */
  tickMs: number;
  /**
   * Fired synchronously right after the run row is created (before the first
   * await). Lets a fire-and-forget caller capture the runId immediately while
   * the rest of the bench runs in the background.
   */
  onRunCreated?: (runId: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TICK_MS = 1_500;
const TERMINAL_STATUSES = new Set(['exited', 'error', 'done']);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Union staged + unstaged + untracked into a de-duplicated changed-file set. */
function changedFilesFrom(status: GitStatus | null): string[] {
  if (!status) return [];
  return [...new Set([...status.staged, ...status.unstaged, ...status.untracked])];
}

/**
 * Build the roster: one entry per provider, each with a DISTINCT role
 * (builder-1, builder-2, …) so each agent lands in its own worktree, and the
 * shared task prompt as its `initialPrompt`.
 */
function buildRoster(providers: string[], taskPrompt: string): BenchRosterEntry[] {
  return providers.map((providerId, i) => ({
    role: 'builder' as Role,
    roleIndex: i + 1,
    providerId,
    initialPrompt: taskPrompt,
  }));
}

/**
 * Run a multi-agent conflict benchmark. See file header for the full contract.
 * Never throws on a per-agent failure — bad git reads / errored agents are
 * captured as empty-changed-file results so the leaderboard always renders.
 */
export async function runConflictBench(
  input: RunConflictBenchInput,
  deps: HarnessDeps,
): Promise<RunConflictBenchResult> {
  const category = input.category ?? 'multi-agent-conflict';
  const workspaceId = input.workspaceId ?? deps.workspaceId;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;

  // 1. Persist a `running` run with one placeholder result per provider.
  const run = deps.store.createRun(deps.db, {
    category,
    taskPrompt: input.taskPrompt,
    providers: input.providers,
  });
  deps.onRunCreated?.(run.id);

  // 2. Spawn the swarm — one distinct-role roster entry per provider.
  const roster = buildRoster(input.providers, input.taskPrompt);
  const swarmInput: CreateSwarmInput = {
    workspaceId,
    mission: input.taskPrompt,
    preset: 'custom',
    name: `SigmaBench: ${category}`,
    // Each entry carries an `initialPrompt` (now declared on RoleAssignment) so
    // the factory spawns every benched agent already working the task — without
    // it the agents idle and the bench is hollow.
    roster,
  };

  let swarm: Swarm;
  try {
    swarm = await deps.createSwarm(swarmInput, deps.swarmFactoryDeps);
  } catch (err) {
    // Swarm never launched — record the run as errored and bail cleanly.
    deps.store.finishRun(deps.db, run.id, [], { status: 'error' });
    void err;
    return { runId: run.id, results: [] };
  }

  // Map sessionId → provider so we can label results even when an agent
  // errors before we can read its worktree.
  const providerBySession = new Map<string, string>();
  for (const agent of swarm.agents) {
    if (agent.sessionId) providerBySession.set(agent.sessionId, agent.providerId);
  }

  // 3. Poll until every agent is terminal or we hit the timeout.
  const start = deps.now();
  let snapshots: SwarmStatusSnapshot[] = [];
  for (;;) {
    snapshots = await deps.readSwarmStatuses(swarm.id);
    const allTerminal =
      snapshots.length > 0 && snapshots.every((s) => isTerminal(s.status));
    if (allTerminal) break;
    if (deps.now() - start >= timeoutMs) break;
    await deps.sleep(tickMs);
  }

  // 4. Per-agent: read the worktree's changed files (skip agents with no
  //    worktree — they errored before producing one). Never throw.
  const perAgent: Array<{
    sessionId: string;
    provider: string;
    changedFiles: string[];
    exitCode: number | null;
  }> = [];

  for (const snap of snapshots) {
    const provider = providerBySession.get(snap.sessionId) ?? 'unknown';
    let changedFiles: string[] = [];
    if (snap.worktreePath) {
      try {
        const status = await deps.gitStatus(snap.worktreePath);
        changedFiles = changedFilesFrom(status);
      } catch {
        // A single worktree read failure must not abort the whole bench.
        changedFiles = [];
      }
    }
    perAgent.push({
      sessionId: snap.sessionId,
      provider,
      changedFiles,
      exitCode: snap.exitCode,
    });
  }

  // 5. Score pairwise overlap and persist.
  const scores = deps.scoreConflicts(
    perAgent.map((a) => ({ sessionId: a.sessionId, changedFiles: a.changedFiles })),
  );
  const scoreBySession = new Map(scores.map((s) => [s.sessionId, s.conflictScore]));

  const finished: FinishResult[] = perAgent.map((a) => ({
    sessionId: a.sessionId,
    provider: a.provider,
    changedFiles: a.changedFiles,
    conflictScore: scoreBySession.get(a.sessionId) ?? 0,
    exitCode: a.exitCode,
  }));

  deps.store.finishRun(deps.db, run.id, finished, { status: 'done' });

  return {
    runId: run.id,
    results: finished.map((f) => ({
      sessionId: f.sessionId,
      provider: f.provider,
      changedFiles: f.changedFiles,
      conflictScore: f.conflictScore,
      exitCode: f.exitCode,
    })),
  };
}
