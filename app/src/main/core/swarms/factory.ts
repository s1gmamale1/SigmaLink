// Swarm factory — creates a swarm row, materialises one PTY agent per role,
// and wires each agent's stdout into the SIGMA:: protocol parser so role
// chatter persists into the mailbox.
//
// Each agent gets its own role-tagged worktree (when the workspace is a Git
// repo) under `sigmalink/<role>-<index>/<8char>` — same scheme as
// `executeLaunchPlan` but with role/index taking the place of `pane-N`.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import {
  agentSessions,
  swarmAgents,
  swarms,
  workspaces as workspacesTable,
} from '../db/schema';
import { findProvider } from '../../../shared/providers';
import type {
  CreateSwarmInput,
  Role,
  Swarm,
  SwarmAgent,
} from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import type { SwarmMailbox } from './mailbox';
import { agentKey as makeAgentKey, defaultRoster, totalForPreset } from './types';
import {
  envelopeToInsert,
  parseProtocolLine,
  ProtocolLineBuffer,
} from './protocol';
import { resolveAndSpawn } from '../providers/launcher';

export interface SwarmFactoryDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  defaultCols?: number;
  defaultRows?: number;
  /** Overrideable for tests; production passes app.getPath('userData'). */
  userDataDir: string;
}

export async function createSwarm(
  input: CreateSwarmInput,
  deps: SwarmFactoryDeps,
): Promise<Swarm> {
  const db = getDb();
  // BUG-W7-006: prefer the workspaceId the caller already has from
  // `workspaces.open`. We look it up directly in the workspaces table — no
  // dependence on `workspaces.list` ordering or caching. If the row really is
  // missing the error is loud and explicit so the renderer surfaces it via
  // the global toaster.
  const wsRow = db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, input.workspaceId))
    .get();
  if (!wsRow) {
    throw new Error(
      `Workspace not found: ${input.workspaceId}. Open the workspace via workspaces.open before creating a swarm.`,
    );
  }

  // Resolve the roster — the operator may have customised per-row providers,
  // otherwise we use the default roster for the preset.
  const roster =
    input.roster && input.roster.length > 0 ? input.roster : defaultRoster(input.preset);
  if (roster.length === 0) {
    throw new Error('Cannot create swarm: empty roster.');
  }
  if (input.preset !== 'custom') {
    const total = totalForPreset(input.preset);
    if (total > 0 && roster.length !== total) {
      // Defensive: if the operator handed us a partial roster for a fixed
      // preset we still launch what we got — this matches the spec's "operator
      // override" intent.
    }
  }

  const swarmId = randomUUID();
  const now = Date.now();
  const name =
    input.name && input.name.trim().length > 0
      ? input.name.trim()
      : input.mission.trim().slice(0, 64) || `Swarm ${swarmId.slice(0, 8)}`;

  db.insert(swarms)
    .values({
      id: swarmId,
      workspaceId: wsRow.id,
      name,
      mission: input.mission,
      preset: input.preset,
      status: 'running',
      createdAt: now,
    })
    .run();

  // V3-W13-014 — multi-hub constellation. We materialise rows in two passes:
  //   1. Insert every coordinator first so we know the queen's id (the very
  //      first coordinator in roster order). Peer coordinators then carry
  //      `coordinatorId = queenId` so the constellation renderer can draw a
  //      single hub for the swarm; non-coordinator agents are assigned to one
  //      coordinator round-robin (the queen included as a hub).
  //   2. Insert non-coordinator agents with their assigned `coordinatorId`.
  // This avoids a nullable-then-update dance and keeps the FK semantics
  // (logical, since SQLite ALTER TABLE ADD COLUMN cannot attach REFERENCES)
  // observable in a single INSERT per row.
  const coordinatorAssignments = roster.filter((r) => r.role === 'coordinator');
  const otherAssignments = roster.filter((r) => r.role !== 'coordinator');
  const coordinatorIds: string[] = [];
  let queenId: string | null = null;

  const agents: SwarmAgent[] = [];

  // Pass 1 — coordinators.
  for (const assignment of coordinatorAssignments) {
    const aKey = makeAgentKey(assignment.role, assignment.roleIndex);
    const agentId = randomUUID();
    const inboxPath = deps.mailbox.ensureInbox(swarmId, aKey);
    // First coordinator becomes the queen (coordinatorId NULL); peers point
    // back at the queen.
    const coordinatorId = queenId; // null for the very first iteration

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

    if (queenId === null) queenId = agentId;
    coordinatorIds.push(agentId);

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
        baseRef: input.baseRef,
        agentKey: aKey,
        deps,
      });
      sessionStatus = 'idle';
    } catch (err) {
      sessionStatus = 'error';
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

    agents.push({
      id: agentId,
      swarmId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      sessionId,
      status: sessionStatus,
      inboxPath,
      agentKey: aKey,
    });
  }

  // Pass 2 — non-coordinator agents, assigned round-robin across coordinators.
  // If no coordinator was rostered (shouldn't happen for stock presets but is
  // legal for `custom`), assignees get `coordinatorId = NULL`.
  let rrCursor = 0;
  for (const assignment of otherAssignments) {
    const aKey = makeAgentKey(assignment.role, assignment.roleIndex);
    const agentId = randomUUID();
    const inboxPath = deps.mailbox.ensureInbox(swarmId, aKey);
    const coordinatorId =
      coordinatorIds.length > 0 ? coordinatorIds[rrCursor % coordinatorIds.length] : null;
    rrCursor += 1;

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
        baseRef: input.baseRef,
        agentKey: aKey,
        deps,
      });
      sessionStatus = 'idle';
    } catch (err) {
      sessionStatus = 'error';
      // We surface the error in the agent row (status='error') and continue
      // creating the rest of the roster. The operator sees the partial swarm
      // in the renderer and can decide whether to kill+retry.
      const message = err instanceof Error ? err.message : String(err);
      // Persist a SYSTEM message so the side-chat surfaces what failed.
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

    agents.push({
      id: agentId,
      swarmId,
      role: assignment.role,
      roleIndex: assignment.roleIndex,
      providerId: assignment.providerId,
      sessionId,
      status: sessionStatus,
      inboxPath,
      agentKey: aKey,
    });
  }

  // System message that opens the mailbox — every roll-call / broadcast will
  // append to the same swarm thread after this.
  void deps.mailbox.append({
    swarmId,
    fromAgent: 'operator',
    toAgent: '*',
    kind: 'SYSTEM',
    body: `Swarm "${name}" launched with mission: ${input.mission}`,
    payload: { preset: input.preset, agentCount: agents.length },
  });

  return {
    id: swarmId,
    workspaceId: wsRow.id,
    name,
    mission: input.mission,
    preset: input.preset,
    status: 'running',
    createdAt: now,
    endedAt: null,
    agents,
  };
}

async function spawnAgentSession(args: {
  wsRow: typeof workspacesTable.$inferSelect;
  swarmId: string;
  agentId: string;
  role: Role;
  roleIndex: number;
  providerId: string;
  baseRef?: string;
  agentKey: string;
  deps: SwarmFactoryDeps;
}): Promise<string> {
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

  const cwd = worktreePath ?? args.wsRow.rootPath;
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
  const spawnResult = resolveAndSpawn(
    { ptyRegistry: args.deps.pty },
    {
      providerId: provider.id,
      cwd,
      cols: args.deps.defaultCols ?? 120,
      rows: args.deps.defaultRows ?? 32,
      showLegacy,
    },
  );
  const rec = spawnResult.ptySession;

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
      startedAt: rec.startedAt,
    })
    .run();
  // BUG-V1.1-02: persist the launcher-resolved provider tag (e.g. 'claude'
  // when the swarm requested 'bridgecode'). Best-effort — column is added by
  // migration 0010; older DBs swallow the failure.
  try {
    getRawDb()
      .prepare('UPDATE agent_sessions SET provider_effective = ? WHERE id = ?')
      .run(spawnResult.providerEffective, rec.id);
  } catch {
    /* column may not exist yet — ignore */
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

export function loadSwarm(swarmId: string): Swarm | null {
  const db = getDb();
  const row = db.select().from(swarms).where(eq(swarms.id, swarmId)).get();
  if (!row) return null;
  const agentRows = db
    .select()
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, swarmId))
    .all();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    mission: row.mission,
    preset: row.preset as Swarm['preset'],
    status: row.status as Swarm['status'],
    createdAt: row.createdAt,
    endedAt: row.endedAt ?? null,
    agents: agentRows.map((r) => ({
      id: r.id,
      swarmId: r.swarmId,
      role: r.role as Role,
      roleIndex: r.roleIndex,
      providerId: r.providerId,
      sessionId: r.sessionId ?? null,
      status: r.status as SwarmAgent['status'],
      inboxPath: r.inboxPath,
      agentKey: r.agentKey,
    })),
  };
}

export function listSwarmsForWorkspace(workspaceId: string): Swarm[] {
  const db = getDb();
  const rows = db
    .select()
    .from(swarms)
    .where(eq(swarms.workspaceId, workspaceId))
    .all();
  return rows
    .map((r) => loadSwarm(r.id))
    .filter((s): s is Swarm => Boolean(s))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * End a swarm: kill every alive PTY belonging to its agents, mark the swarm
 * row 'completed', and clean up any zero-byte inbox files we created.
 */
export function killSwarm(swarmId: string, deps: { pty: PtyRegistry; userDataDir: string }): void {
  const db = getDb();
  const agentRows = db
    .select()
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, swarmId))
    .all();
  for (const a of agentRows) {
    if (a.sessionId) {
      try {
        deps.pty.kill(a.sessionId);
      } catch {
        /* ignore */
      }
    }
  }
  db.update(swarms)
    .set({ status: 'completed', endedAt: Date.now() })
    .where(eq(swarms.id, swarmId))
    .run();

  // Best-effort prune of empty inbox files. Leave non-empty mirrors for
  // forensic value.
  const swarmDir = path.join(deps.userDataDir, 'swarms', swarmId, 'inboxes');
  try {
    if (fs.existsSync(swarmDir)) {
      for (const file of fs.readdirSync(swarmDir)) {
        const p = path.join(swarmDir, file);
        try {
          const st = fs.statSync(p);
          if (st.size === 0) fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
