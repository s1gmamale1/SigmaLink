// Swarm Room RPC controller. Wires the renderer's `swarms.*` calls into the
// factory + mailbox. The controller is intentionally thin: every method maps
// 1:1 to a single durable side-effect (DB write or PTY interaction).

import { eq } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import type {
  CreateSwarmInput,
  Swarm,
  SwarmMessage,
  SwarmMessageKind,
} from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import { getDb } from '../db/client';
import { swarmAgents } from '../db/schema';
import { SwarmMailbox } from './mailbox';
import {
  createSwarm,
  killSwarm,
  listSwarmsForWorkspace,
  loadSwarm,
} from './factory';
import {
  formatBroadcast,
  formatRollCall,
  formatStdinDelivery,
} from './protocol';

export interface SwarmControllerDeps {
  pty: PtyRegistry;
  worktreePool: WorktreePool;
  mailbox: SwarmMailbox;
  userDataDir: string;
}

export function buildSwarmController(deps: SwarmControllerDeps) {
  return defineController({
    create: async (input: CreateSwarmInput): Promise<Swarm> => {
      return createSwarm(input, {
        pty: deps.pty,
        worktreePool: deps.worktreePool,
        mailbox: deps.mailbox,
        userDataDir: deps.userDataDir,
      });
    },
    list: async (workspaceId: string): Promise<Swarm[]> => {
      return listSwarmsForWorkspace(workspaceId);
    },
    get: async (id: string): Promise<Swarm | null> => {
      return loadSwarm(id);
    },
    sendMessage: async (input: {
      swarmId: string;
      toAgent: string;
      body: string;
      kind?: SwarmMessageKind;
    }): Promise<SwarmMessage> => {
      const kind: SwarmMessageKind = input.kind ?? 'OPERATOR';
      const message = await deps.mailbox.append({
        swarmId: input.swarmId,
        fromAgent: 'operator',
        toAgent: input.toAgent,
        kind,
        body: input.body,
      });
      // Dual delivery: the mailbox is durable; we additionally type the line
      // into each targeted agent's PTY so the LLM sees it as user input.
      writeToPtys(deps, input.swarmId, input.toAgent, {
        fromAgent: 'operator',
        toAgent: input.toAgent,
        body: input.body,
        kind,
      });
      return message;
    },
    broadcast: async (swarmId: string, body: string): Promise<SwarmMessage> => {
      const env = formatBroadcast(body);
      const message = await deps.mailbox.append({
        swarmId,
        fromAgent: 'operator',
        toAgent: env.toAgent,
        kind: env.kind,
        body: env.body,
      });
      writeToPtys(deps, swarmId, env.toAgent, {
        fromAgent: 'operator',
        toAgent: env.toAgent,
        body: env.body,
        kind: env.kind,
      });
      return message;
    },
    rollCall: async (swarmId: string): Promise<SwarmMessage> => {
      const env = formatRollCall();
      const message = await deps.mailbox.append({
        swarmId,
        fromAgent: 'operator',
        toAgent: env.toAgent,
        kind: env.kind,
        body: env.body,
        payload: env.payload,
      });
      writeToPtys(deps, swarmId, env.toAgent, {
        fromAgent: 'operator',
        toAgent: env.toAgent,
        body: env.body,
        kind: env.kind,
      });
      return message;
    },
    tail: async (
      swarmId: string,
      opts?: { limit?: number },
    ): Promise<SwarmMessage[]> => {
      return deps.mailbox.tail(swarmId, opts);
    },
    kill: async (id: string): Promise<void> => {
      killSwarm(id, { pty: deps.pty, userDataDir: deps.userDataDir });
    },
  });
}

function writeToPtys(
  deps: SwarmControllerDeps,
  swarmId: string,
  toAgent: string,
  msg: { fromAgent: string; toAgent: string; body: string; kind: SwarmMessageKind },
): void {
  const db = getDb();
  const agentRows = db
    .select()
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, swarmId))
    .all();
  const targets =
    toAgent === '*'
      ? agentRows
      : agentRows.filter((a) => a.agentKey === toAgent);
  const line = formatStdinDelivery(msg);
  for (const a of targets) {
    if (!a.sessionId) continue;
    try {
      deps.pty.write(a.sessionId, line);
    } catch {
      /* ignore — PTY may have exited */
    }
  }
}
