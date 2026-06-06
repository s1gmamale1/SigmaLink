// v1.4.5 — `addAgentToSwarm` extracted from `factory.ts` to keep the public-
// surface module under 300 LOC. INTERNAL — only `factory.ts` re-exports this.
//
// Contains the full addAgentToSwarm implementation including the
// BUG-V1.1.3-ORCH-02 SQLite transaction guard. Public types
// (AddAgentToSwarmInput, AddAgentToSwarmResult, SwarmFactoryDeps) remain
// owned by factory.ts and are imported here to avoid duplicating contracts.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import {
  swarms,
  swarmAgents,
  workspaces as workspacesTable,
} from '../db/schema';
import type { AgentSession, Swarm } from '../../../shared/types';
import { agentKey as makeAgentKey } from './types';
import { loadAgentSession, loadSwarm, pickCoordinatorId, spawnAgentSession } from './factory-spawn';
import { WorktreeDiskGuardError } from '../git/worktree';
import type { AddInput } from '../notifications/manager';
import type {
  AddAgentToSwarmInput,
  AddAgentToSwarmResult,
  SwarmFactoryDeps,
} from './factory';
import { checkRamBrakeAdmission } from '../ram-brake/admission';

const MAX_SWARM_AGENTS = 20;

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

  const role = input.role ?? 'builder';
  const agentId = randomUUID();
  const now = Date.now();

  checkRamBrakeAdmission(getRawDb(), {
    workspaceId: wsRow.id,
    requestedProfiles: [input.runtimeProfileId],
    force: input.forceRamBrake === true,
  });

  // BUG-V1.1.3-ORCH-02 (audit fix): the prior implementation computed
  // `maxRoleIndex` from a `SELECT … FROM swarm_agents WHERE swarm_id = ?`
  // snapshot, then issued an `INSERT` *outside* any transaction. Two concurrent
  // `addAgentToSwarm` calls for the same role would both observe the same
  // pre-INSERT snapshot, compute identical role indices, and trip the
  // `swarm_agents_role_uq UNIQUE(swarm_id, role, role_index)` constraint on
  // the loser.
  //
  // The fix: wrap (count guard, max(role_index) lookup, INSERT) in a single
  // better-sqlite3 transaction. better-sqlite3 transactions are synchronous
  // BEGIN/COMMIT pairs — concurrent calls serialise on the SQLite write lock,
  // so the second caller sees the first caller's INSERT before computing its
  // own role index. We still hold the per-process `inboxPath` and
  // `coordinatorId` derivation outside the transaction body because they read
  // only the seeded roster snapshot from inside the txn — both are pure
  // functions of `agentRows`.
  let roleIndex = -1;
  let paneIndex = -1;
  let aKey = '';
  let inboxPath = '';

  const raw = getRawDb();
  const txn = raw.transaction(() => {
    const agentRows = db
      .select()
      .from(swarmAgents)
      .where(eq(swarmAgents.swarmId, input.swarmId))
      .all();
    if (agentRows.length >= MAX_SWARM_AGENTS) {
      throw new Error(`Cannot add agent: swarm already has ${MAX_SWARM_AGENTS} agents.`);
    }

    const maxRoleIndex = agentRows
      .filter((a) => a.role === role)
      .reduce((max, a) => Math.max(max, a.roleIndex), 0);
    roleIndex = maxRoleIndex + 1;
    aKey = makeAgentKey(role, roleIndex);
    inboxPath = deps.mailbox.ensureInbox(input.swarmId, aKey);
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
        // SF-8 — persist Yolo/Bypass on the swarm agent row.
        autoApprove: input.autoApprove ? 1 : 0,
      })
      .run();
  });
  txn();

  let sessionId: string;
  try {
    const spawn = await spawnAgentSession({
      wsRow,
      swarmId: input.swarmId,
      agentId,
      role,
      roleIndex,
      providerId: input.providerId,
      agentKey: aKey,
      initialPrompt: input.initialPrompt,
      runtimeProfileId: input.runtimeProfileId,
      autoApprove: input.autoApprove,
      // BSP-V2 — thread the per-spawn model id (mirrors autoApprove pattern).
      modelId: input.modelId,
      // DEV-W5 — thread the per-spawn worktree override (mirrors autoApprove).
      skipWorktree: input.skipWorktree,
      deps,
      // v1.4.3 #06 — propagate the worktree-share override when the caller
      // (splitPane RPC) provides one. All other callers leave these undefined
      // so the legacy "fresh worktree per agent" path stays intact.
      worktreePathOverride: input.worktreePath,
      cwdOverride: input.cwd,
      branchOverride: input.branch,
    });
    sessionId = spawn.sessionId;
    paneIndex = spawn.paneIndex;
  } catch (err) {
    db.update(swarmAgents)
      .set({ status: 'error' })
      .where(eq(swarmAgents.id, agentId))
      .run();
    const message = err instanceof Error ? err.message : String(err);
    // C6 obs (sibling twin of factory-spawn.ts:521 / launcher.ts) — the +Pane
    // spawn path must surface a disk-floor/cap refusal the same way: a critical
    // notification (the only operator-visible channel in a packaged app) plus a
    // structured console.warn for the dev log.
    if (err instanceof WorktreeDiskGuardError) {
      console.warn(
        '[factory-add-agent] disk-guard refused spawn code=%s ws=%s: %s',
        err.code,
        wsRow.id,
        err.message,
      );
      deps.notifications?.add({
        workspaceId: wsRow.id,
        kind: 'disk-guard',
        severity: 'critical',
        title: 'Disk guard triggered',
        body: err.message,
        dedupKey: `disk-guard:${err.code}`,
        payload: { code: err.code },
      } as AddInput);
    }
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

  const session = loadAgentSession(sessionId) as AgentSession;
  const swarm = loadSwarm(input.swarmId) as Swarm;
  if (!session || !swarm) {
    throw new Error(`Added ${aKey}, but failed to reload session metadata.`);
  }

  return { sessionId, paneIndex, agentKey: aKey, session, swarm };
}
