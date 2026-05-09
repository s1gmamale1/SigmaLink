// Swarm Room RPC controller. Wires the renderer's `swarms.*` calls into the
// factory + mailbox. The controller is intentionally thin: every method maps
// 1:1 to a single durable side-effect (DB write or PTY interaction).

import { and, eq } from 'drizzle-orm';
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
import { swarmAgents, swarmSkills } from '../db/schema';
import { SwarmMailbox } from './mailbox';
import type { MailboxKind } from './types';
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
      kind?: SwarmMessageKind | MailboxKind;
      payload?: Record<string, unknown>;
      /** V3-W13-009 — when set on a `directive` envelope, mailbox echoes the
       *  line into the target agent's PTY stdin in addition to the durable
       *  mailbox row. */
      echo?: 'pane';
    }): Promise<SwarmMessage> => {
      const kind = (input.kind ?? 'OPERATOR') as SwarmMessageKind | MailboxKind;
      // V3-W13-011 — for `skill_toggle` envelopes, mirror the on/off flip
      // into `swarm_skills` so coordinators can read the active skill set
      // without re-tailing the mailbox. We accept either a structured
      // payload `{ skillKey, on, group }` (preferred) OR a body of the form
      // `<skillKey>=on|off` (renderer fallback when no payload is sent).
      // Group falls back to 'workflow' when the renderer didn't provide one;
      // the renderer always sets it for the 12-tile grid, but keeping a
      // default makes the controller resilient to future producers.
      if (kind === 'skill_toggle') {
        mirrorSkillToggle(input.swarmId, input.body, input.payload);
      }
      const message = await deps.mailbox.append({
        swarmId: input.swarmId,
        fromAgent: 'operator',
        toAgent: input.toAgent,
        kind,
        body: input.body,
        payload: input.payload,
        echo: input.echo,
      });
      // Dual delivery: the mailbox is durable; we additionally type the
      // legacy SIGMA::* line into each targeted agent's PTY so the LLM sees
      // it as user input. For `directive.echo='pane'`, the mailbox itself
      // already wrote the `[Operator → Role N]` line — skip the SIGMA::
      // duplicate so the agent doesn't see two lines for the same DM.
      const isDirectivePaneEcho =
        kind === 'directive' && input.echo === 'pane';
      if (!isDirectivePaneEcho) {
        writeToPtys(deps, input.swarmId, input.toAgent, {
          fromAgent: 'operator',
          toAgent: input.toAgent,
          body: input.body,
          kind: kind as SwarmMessageKind,
        });
      }
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

/**
 * V3-W13-011 — mirror a `skill_toggle` envelope into the `swarm_skills`
 * table. Accepts either a typed payload from the renderer (preferred) or
 * a body of the form `<skillKey>=on|off` so legacy producers keep working.
 * Failures are swallowed: the durable mailbox row is the source of truth,
 * and a missing mirror row simply falls back to "off" at read time.
 */
function mirrorSkillToggle(
  swarmId: string,
  body: string,
  payload: Record<string, unknown> | undefined,
): void {
  let skillKey: string | null = null;
  let on: boolean | null = null;
  let group: string = 'workflow';
  if (payload && typeof payload === 'object') {
    const k = payload['skillKey'];
    const o = payload['on'];
    const g = payload['group'];
    if (typeof k === 'string') skillKey = k;
    if (typeof o === 'boolean') on = o;
    if (typeof g === 'string') group = g;
  }
  if (!skillKey || on === null) {
    // Body fallback: `<skillKey>=on|off`
    const m = /^([a-z0-9-]+)=(on|off)$/i.exec(body.trim());
    if (m) {
      skillKey = skillKey ?? m[1];
      on = on ?? m[2].toLowerCase() === 'on';
    }
  }
  if (!skillKey || on === null) return;
  try {
    const db = getDb();
    const updatedAt = Date.now();
    // Two-step upsert: existence-probe then update-or-insert. Drizzle's
    // `onConflictDoUpdate` syntax varies by driver, so we match the
    // `kvSet` convention in console-controller.ts to keep the DDL portable
    // across the better-sqlite3 + libsql build targets.
    const existing = db
      .select({ swarmId: swarmSkills.swarmId })
      .from(swarmSkills)
      .where(and(eq(swarmSkills.swarmId, swarmId), eq(swarmSkills.skillKey, skillKey)))
      .get();
    if (existing) {
      db.update(swarmSkills)
        .set({ on: on ? 1 : 0, group, updatedAt })
        .where(and(eq(swarmSkills.swarmId, swarmId), eq(swarmSkills.skillKey, skillKey)))
        .run();
    } else {
      db.insert(swarmSkills)
        .values({ swarmId, skillKey, on: on ? 1 : 0, group, updatedAt })
        .run();
    }
  } catch {
    /* mirror failure is non-fatal */
  }
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
