// V1.1.9 — Private spawn helpers for the swarm factory.
//
// Extracted from `factory.ts` to keep the public-surface module under the
// 400-LOC limit. This module is INTERNAL — only `factory.ts` is expected to
// import from it. External callers (controller.ts, assistant/tools.ts) stay
// pinned to the `factory.ts` re-exports.
//
// Each helper here was relocated verbatim from `factory.ts`; the only changes
// are (a) imports trimmed to what these helpers actually use, and (b) the
// `SwarmFactoryDeps` type is re-imported from `./factory` so the spawn arg
// shapes continue to match the public contract.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import {
  agentSessions,
  swarmAgents,
  workspaces as workspacesTable,
} from '../db/schema';
import { findProvider } from '../../../shared/providers';
import type { AgentSession, Role, SwarmAgent } from '../../../shared/types';
import { agentKey as makeAgentKey } from './types';
import { envelopeToInsert, parseProtocolLine, ProtocolLineBuffer } from './protocol';
import { resolveAndSpawn } from '../providers/launcher';
import type { SwarmFactoryDeps } from './factory';
import { workspaceCwdInWorktree } from '../workspaces/worktree-cwd';
import {
  ensureClaudeProjectDir,
  prepareClaudeWorkspaceContext,
} from '../pty/claude-resume-bridge';

/**
 * Pick the coordinator that a newly-added agent should be assigned to.
 *
 * The "queen" is the first coordinator (the one whose `coordinatorId` is
 * NULL); other coordinators are peers that point back at the queen. For a
 * `custom`-preset swarm with no coordinator, this returns null.
 */
export function pickCoordinatorId(
  agentRows: Array<typeof swarmAgents.$inferSelect>,
  role: Role,
): string | null {
  const coordinators = agentRows.filter((a) => a.role === 'coordinator');
  if (coordinators.length === 0) return null;
  const queen = coordinators.find((a) => !a.coordinatorId) ?? coordinators[0];
  if (role === 'coordinator') return queen?.id ?? null;
  return queen?.id ?? null;
}

/**
 * Translate an `initialPrompt` into provider-specific CLI arguments.
 *
 * Providers may declare `oneshotArgs` (token list with `{prompt}` placeholder)
 * or a single `initialPromptFlag`. Providers that support neither fall back to
 * a delayed stdin write inside `spawnAgentSession`.
 */
export function buildExtraArgs(providerId: string, initialPrompt?: string): string[] {
  const provider = findProvider(providerId);
  if (!provider || !initialPrompt) return [];
  if (provider.oneshotArgs && provider.oneshotArgs.length) {
    return provider.oneshotArgs.map((tok) => tok.replace('{prompt}', initialPrompt));
  }
  if (provider.initialPromptFlag) {
    return [provider.initialPromptFlag, initialPrompt];
  }
  return [];
}

/**
 * Reload an `agent_sessions` row by id and map it into the shared
 * `AgentSession` shape that the renderer / RPC layer consumes.
 */
export function loadAgentSession(sessionId: string): AgentSession | null {
  const row = getDb()
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    cwd: row.cwd,
    branch: row.branch ?? null,
    status: row.status as AgentSession['status'],
    exitCode: row.exitCode ?? undefined,
    startedAt: row.startedAt,
    exitedAt: row.exitedAt ?? undefined,
    worktreePath: row.worktreePath ?? null,
    initialPrompt: row.initialPrompt ?? undefined,
  };
}

export interface SpawnAgentSessionArgs {
  wsRow: typeof workspacesTable.$inferSelect;
  swarmId: string;
  agentId: string;
  role: Role;
  roleIndex: number;
  providerId: string;
  baseRef?: string;
  agentKey: string;
  initialPrompt?: string;
  deps: SwarmFactoryDeps;
}

/**
 * Spawn one swarm agent's PTY, persist its `agent_sessions` row, and wire its
 * stdout into the SIGMA:: protocol parser → mailbox pipeline.
 *
 * Returns the new session id on success. Throws if the provider can't be
 * resolved or the worktree allocator fails. Caller is responsible for
 * marking the corresponding `swarm_agents` row.
 */
export async function spawnAgentSession(args: SpawnAgentSessionArgs): Promise<string> {
  const provider = findProvider(args.providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${args.providerId}`);
  }

  const db = getDb();
  let worktreePath: string | null = null;
  let branch: string | null = null;
  if (args.wsRow.repoMode === 'git' && args.wsRow.repoRoot) {
    const r = await args.deps.worktreePool.create({
      repoRoot: args.wsRow.repoRoot,
      role: args.role,
      hint: `${args.role}-${args.roleIndex}`,
      base: args.baseRef,
    });
    worktreePath = r.worktreePath;
    branch = r.branch;
  }

  const cwd = workspaceCwdInWorktree({
    workspaceRoot: args.wsRow.rootPath,
    repoRoot: args.wsRow.repoRoot,
    worktreePath,
  });
  // V1.1: route swarm-agent spawns through the provider launcher façade so
  // BridgeCode→Claude fallback, altCommands ENOENT walk, and the legacy gate
  // all apply uniformly. Read `kv['providers.showLegacy']` defensively — if
  // the row is missing the default is "hidden".
  let showLegacy = false;
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('providers.showLegacy') as { value?: string } | undefined;
    showLegacy = row?.value === '1' || row?.value === 'true';
  } catch {
    /* ignore — default to false */
  }
  const extraArgs = buildExtraArgs(provider.id, args.initialPrompt);
  if (provider.id === 'claude') {
    await prepareClaudeWorkspaceContext(args.wsRow.rootPath, cwd);
    await ensureClaudeProjectDir(cwd);
  }
  const spawnResult = resolveAndSpawn(
    { ptyRegistry: args.deps.pty },
    {
      providerId: provider.id,
      cwd,
      cols: args.deps.defaultCols ?? 120,
      rows: args.deps.defaultRows ?? 32,
      showLegacy,
      extraArgs,
    },
  );
  const rec = spawnResult.ptySession;
  const effectiveProvider = findProvider(spawnResult.providerEffective) ?? provider;

  // Tag the agent_sessions row with the swarm so future rooms (Review, Tasks)
  // can correlate sessions to swarm agents.
  db.insert(agentSessions)
    .values({
      id: rec.id,
      workspaceId: args.wsRow.id,
      providerId: provider.id,
      cwd,
      branch,
      worktreePath,
      status: 'running',
      initialPrompt: args.initialPrompt,
      startedAt: rec.startedAt,
      externalSessionId: rec.externalSessionId,
    })
    .run();
  // BUG-V1.1-02: persist the launcher-resolved provider tag. The launcher
  // façade always records `providerEffective`, even when no comingSoon swap
  // occurred, so downstream queries don't have to special-case nulls.
  // Best-effort — column is added by migration 0010; older DBs swallow the
  // failure.
  try {
    getRawDb()
      .prepare('UPDATE agent_sessions SET provider_effective = ? WHERE id = ?')
      .run(spawnResult.providerEffective, rec.id);
  } catch {
    /* column may not exist yet — ignore */
  }

  if (
    args.initialPrompt &&
    !effectiveProvider.oneshotArgs?.length &&
    !effectiveProvider.initialPromptFlag
  ) {
    setTimeout(() => {
      try {
        args.deps.pty.write(rec.id, args.initialPrompt + '\n');
      } catch {
        /* ignore */
      }
    }, 600);
  }

  // Wire SIGMA:: protocol. The PTY ring buffer continues to receive raw bytes
  // for live terminal rendering; we additionally split chunks by line and
  // route SIGMA:: matches into the mailbox.
  const buf = new ProtocolLineBuffer();
  rec.pty.onData((chunk) => {
    buf.push(chunk, (line) => {
      const parsed = parseProtocolLine(line);
      if (!parsed) return;
      const insert = envelopeToInsert(args.swarmId, args.agentKey, parsed);
      void args.deps.mailbox.append(insert).catch(() => {
        /* mailbox append errors surface via the queue's reject */
      });
    });
  });

  // When the PTY exits, mark agent + session rows accordingly. Mirrors the
  // logic in launcher.ts so the same "early death = error" heuristic applies.
  const startedMs = rec.startedAt;
  rec.pty.onExit(({ exitCode }) => {
    const earlyDeath = exitCode < 0 && Date.now() - startedMs < 1500;
    try {
      db.update(agentSessions)
        .set({
          status: earlyDeath ? 'error' : 'exited',
          exitCode,
          exitedAt: Date.now(),
        })
        .where(eq(agentSessions.id, rec.id))
        .run();
      db.update(swarmAgents)
        .set({ status: earlyDeath ? 'error' : 'done' })
        .where(eq(swarmAgents.id, args.agentId))
        .run();
    } catch {
      /* db may be closing during shutdown */
    }
  });

  return rec.id;
}

export interface MaterializeRosterAgentArgs {
  swarmId: string;
  wsRow: typeof workspacesTable.$inferSelect;
  assignment: { role: Role; roleIndex: number; providerId: string };
  coordinatorId: string | null;
  baseRef?: string;
  now: number;
  deps: SwarmFactoryDeps;
}

/**
 * Materialise one roster agent: insert the `swarm_agents` row, attempt to
 * spawn its PTY session, then patch the row with the resulting sessionId /
 * status. Returns the canonical {@link SwarmAgent} shape and the spawn-time
 * coordinator id (so the caller can append it to its `coordinatorIds` list
 * when relevant).
 *
 * Spawn errors are captured here (status='error', mailbox SYSTEM message);
 * we never throw out of this helper — `createSwarm` must keep building the
 * rest of the roster even if one agent fails to launch.
 */
export async function materializeRosterAgent(
  args: MaterializeRosterAgentArgs,
): Promise<{ agentId: string; agent: SwarmAgent }> {
  const { swarmId, wsRow, assignment, coordinatorId, baseRef, now, deps } = args;
  const db = getDb();
  const aKey = makeAgentKey(assignment.role, assignment.roleIndex);
  const agentId = randomUUID();
  const inboxPath = deps.mailbox.ensureInbox(swarmId, aKey);

  db.insert(swarmAgents)
    .values({
      id: agentId,
      swarmId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      status: 'idle',
      inboxPath,
      agentKey: aKey,
      coordinatorId,
      createdAt: now,
    })
    .run();

  let sessionId: string | null = null;
  let sessionStatus: SwarmAgent['status'] = 'idle';
  try {
    sessionId = await spawnAgentSession({
      wsRow,
      swarmId,
      agentId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      baseRef,
      agentKey: aKey,
      deps,
    });
    sessionStatus = 'idle';
  } catch (err) {
    sessionStatus = 'error';
    // Surface the error in the agent row and persist a SYSTEM message so the
    // side-chat shows what failed. We never throw — `createSwarm` keeps going
    // with the rest of the roster; the operator can kill+retry from the UI.
    const message = err instanceof Error ? err.message : String(err);
    void deps.mailbox.append({
      swarmId,
      fromAgent: 'operator',
      toAgent: aKey,
      kind: 'SYSTEM',
      body: `Failed to spawn ${aKey}: ${message}`,
    });
  }

  if (sessionId) {
    db.update(swarmAgents)
      .set({ sessionId, status: sessionStatus })
      .where(eq(swarmAgents.id, agentId))
      .run();
  } else {
    db.update(swarmAgents)
      .set({ status: sessionStatus })
      .where(eq(swarmAgents.id, agentId))
      .run();
  }

  return {
    agentId,
    agent: {
      id: agentId,
      swarmId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      sessionId,
      status: sessionStatus,
      inboxPath,
      agentKey: aKey,
    },
  };
}
