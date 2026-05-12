// Swarm factory — creates a swarm row, materialises one PTY agent per role,
// and wires each agent's stdout into the SIGMA:: protocol parser. Each agent
// gets its own role-tagged worktree (when the workspace is a Git repo) under
// `sigmalink/<role>-<index>/<8char>`.
//
// V1.1.9: spawn-side helpers live in `./factory-spawn`; this module now
// holds only the public surface (`createSwarm`, `addAgentToSwarm`,
// `listSwarmsForWorkspace`, `loadSwarm`, `killSwarm`).

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  swarmAgents,
  swarms,
  workspaces as workspacesTable,
} from '../db/schema';
import type {
  AgentSession,
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
  loadAgentSession,
  materializeRosterAgent,
  pickCoordinatorId,
  spawnAgentSession,
} from './factory-spawn';

const MAX_SWARM_AGENTS = 20;

export interface SwarmFactoryDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  defaultCols?: number;
  defaultRows?: number;
  /** Overrideable for tests; production passes app.getPath('userData'). */
  userDataDir: string;
}

export interface AddAgentToSwarmInput {
  swarmId: string;
  providerId: string;
  role?: Role;
  initialPrompt?: string;
}

export interface AddAgentToSwarmResult {
  sessionId: string;
  paneIndex: number;
  agentKey: string;
  session: AgentSession;
  swarm: Swarm;
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
  if (roster.length > MAX_SWARM_AGENTS) {
    throw new Error(`Cannot create swarm: roster exceeds ${MAX_SWARM_AGENTS} agents.`);
  }
  // Defensive: for non-`custom` presets we still launch the supplied roster
  // even if its length disagrees with `totalForPreset` — matches the spec's
  // "operator override" intent.
  if (input.preset !== 'custom') void totalForPreset(input.preset);

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

  // Pass 1 — coordinators. First coordinator becomes the queen
  // (coordinatorId NULL); peers point back at the queen.
  for (const assignment of coordinatorAssignments) {
    const { agentId, agent } = await materializeRosterAgent({
      swarmId,
      wsRow,
      assignment,
      coordinatorId: queenId, // null for the very first iteration
      baseRef: input.baseRef,
      now,
      deps,
    });
    if (queenId === null) queenId = agentId;
    coordinatorIds.push(agentId);
    agents.push(agent);
  }

  // Pass 2 — non-coordinator agents, assigned round-robin across coordinators.
  // If no coordinator was rostered (legal for `custom`), assignees get
  // `coordinatorId = NULL`.
  let rrCursor = 0;
  for (const assignment of otherAssignments) {
    const coordinatorId =
      coordinatorIds.length > 0 ? coordinatorIds[rrCursor % coordinatorIds.length] : null;
    rrCursor += 1;
    const { agent } = await materializeRosterAgent({
      swarmId,
      wsRow,
      assignment,
      coordinatorId,
      baseRef: input.baseRef,
      now,
      deps,
    });
    agents.push(agent);
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

export async function addAgentToSwarm(
  input: AddAgentToSwarmInput,
  deps: SwarmFactoryDeps,
): Promise<AddAgentToSwarmResult> {
  const db = getDb();
  const swarmRow = db.select().from(swarms).where(eq(swarms.id, input.swarmId)).get();
  if (!swarmRow) {
    throw new Error(`Swarm not found: ${input.swarmId}`);
  }
  if (swarmRow.status !== 'running') {
    throw new Error(`Cannot add agent to swarm ${input.swarmId}: status is ${swarmRow.status}.`);
  }

  const wsRow = db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, swarmRow.workspaceId))
    .get();
  if (!wsRow) {
    throw new Error(`Workspace not found for swarm ${input.swarmId}: ${swarmRow.workspaceId}`);
  }

  const agentRows = db
    .select()
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, input.swarmId))
    .all();
  if (agentRows.length >= MAX_SWARM_AGENTS) {
    throw new Error(`Cannot add agent: swarm already has ${MAX_SWARM_AGENTS} agents.`);
  }

  const role = input.role ?? 'builder';
  const maxRoleIndex = agentRows
    .filter((a) => a.role === role)
    .reduce((max, a) => Math.max(max, a.roleIndex), 0);
  const roleIndex = maxRoleIndex + 1;
  const aKey = makeAgentKey(role, roleIndex);
  const paneIndex = agentRows.length === 0 ? 0 : agentRows.length;
  const agentId = randomUUID();
  const now = Date.now();
  const inboxPath = deps.mailbox.ensureInbox(input.swarmId, aKey);
  const coordinatorId = pickCoordinatorId(agentRows, role);

  db.insert(swarmAgents)
    .values({
      id: agentId,
      swarmId: input.swarmId,
      role,
      roleIndex,
      providerId: input.providerId,
      status: 'idle',
      inboxPath,
      agentKey: aKey,
      coordinatorId,
      createdAt: now,
    })
    .run();

  let sessionId: string;
  try {
    sessionId = await spawnAgentSession({
      wsRow,
      swarmId: input.swarmId,
      agentId,
      role,
      roleIndex,
      providerId: input.providerId,
      agentKey: aKey,
      initialPrompt: input.initialPrompt,
      deps,
    });
  } catch (err) {
    db.update(swarmAgents)
      .set({ status: 'error' })
      .where(eq(swarmAgents.id, agentId))
      .run();
    const message = err instanceof Error ? err.message : String(err);
    void deps.mailbox.append({
      swarmId: input.swarmId,
      fromAgent: 'operator',
      toAgent: aKey,
      kind: 'SYSTEM',
      body: `Failed to spawn ${aKey}: ${message}`,
    });
    throw err;
  }

  db.update(swarmAgents)
    .set({ sessionId, status: 'idle' })
    .where(eq(swarmAgents.id, agentId))
    .run();

  void deps.mailbox.append({
    swarmId: input.swarmId,
    fromAgent: 'operator',
    toAgent: aKey,
    kind: 'SYSTEM',
    body: `Added ${aKey} to swarm "${swarmRow.name}".`,
    payload: { paneIndex, providerId: input.providerId },
  });

  const session = loadAgentSession(sessionId);
  const swarm = loadSwarm(input.swarmId);
  if (!session || !swarm) {
    throw new Error(`Added ${aKey}, but failed to reload session metadata.`);
  }

  return { sessionId, paneIndex, agentKey: aKey, session, swarm };
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
