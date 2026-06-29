// Swarm factory — creates a swarm row, materialises one PTY agent per role,
// and wires each agent's stdout into the SIGMA:: protocol parser. Each agent
// gets its own role-tagged worktree (when the workspace is a Git repo) under
// `sigmalink/<role>-<index>/<8char>`.
//
// V1.1.9: spawn-side helpers live in `./factory-spawn`; this module now
// holds only the public surface (`createSwarm`, `addAgentToSwarm`,
// `listSwarmsForWorkspace`, `loadSwarm`, `killSwarm`).
// v1.4.5: `addAgentToSwarm` body → `./factory-add-agent`;
//          `loadSwarm` body → `./factory-spawn` (re-exported here).

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import {
  swarms,
  swarmAgents,
  workspaces as workspacesTable,
} from '../db/schema';
import type {
  AgentSession,
  CreateSwarmInput,
  Swarm,
  SwarmAgent,
} from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import type { SwarmMailbox } from './mailbox';
import { defaultRoster, totalForPreset } from './types';
import { loadSwarm, materializeRosterAgent } from './factory-spawn';
import { checkRamBrakeAdmission } from '../ram-brake/admission';
import { MAX_SWARM_AGENTS } from '../../../shared/providers';

// Re-export loadSwarm so existing callers (controller.ts, tools.ts) are unaffected.
export { loadSwarm } from './factory-spawn';
// Re-export addAgentToSwarm for the same reason.
export { addAgentToSwarm } from './factory-add-agent';

export interface SwarmFactoryDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  defaultCols?: number;
  defaultRows?: number;
  /** Overrideable for tests; production passes app.getPath('userData'). */
  userDataDir: string;
  /**
   * C6 obs — optional notifications sink for disk-guard alerts. When provided,
   * a WorktreeDiskGuardError in materializeRosterAgent triggers a critical
   * notification. Callers that don't thread notifications still get console.warn.
   */
  notifications?: { add: (input: import('../notifications/manager').AddInput) => unknown };
}

// BUG-13 — `AddAgentToSwarmInput` was defined twice (here + `shared/types.ts`).
// The shared definition is now the single source of truth (it gained the
// v1.4.3 #06 split-pane fields `worktreePath`/`cwd`/`branch` during the merge).
// Re-export it here so existing `./factory` consumers (factory-add-agent.ts,
// controller.ts, factory.test.ts) keep importing from the same path.
export type { AddAgentToSwarmInput } from '../../../shared/types';

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
  const roster: CreateSwarmInput['roster'] =
    input.roster && input.roster.length > 0 ? input.roster : defaultRoster(input.preset);
  // v1.13.2 — a `custom`-preset swarm is a valid empty container: the renderer
  // create-then-addAgent flow provisions a bare swarm row, then attaches the
  // first pane via addAgent. Only non-custom presets require a non-empty roster.
  if (roster.length === 0 && input.preset !== 'custom') {
    throw new Error('Cannot create swarm: empty roster.');
  }
  if (roster.length > MAX_SWARM_AGENTS) {
    throw new Error(`Cannot create swarm: roster exceeds ${MAX_SWARM_AGENTS} agents.`);
  }
  // Defensive: for non-`custom` presets we still launch the supplied roster
  // even if its length disagrees with `totalForPreset` — matches the spec's
  // "operator override" intent.
  if (input.preset !== 'custom') void totalForPreset(input.preset);

  checkRamBrakeAdmission(getRawDb(), {
    workspaceId: wsRow.id,
    requestedProfiles: roster.map((assignment) => assignment.runtimeProfileId),
    force: input.forceRamBrake === true,
  });

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
