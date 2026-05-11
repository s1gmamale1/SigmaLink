// Swarm Room RPC controller. Wires the renderer's `swarms.*` calls into the
// factory + mailbox. The controller is intentionally thin: every method maps
// 1:1 to a single durable side-effect (DB write or PTY interaction).

import { and, eq } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import type {
  AddAgentToSwarmInput,
  AddAgentToSwarmResult,
  CreateSwarmInput,
  Swarm,
  SwarmMessage,
  SwarmMessageKind,
} from '../../../shared/types';
import type { PtyRegistry } from '../pty/registry';
import type { WorktreePool } from '../git/worktree';
import { getDb } from '../db/client';
import { swarmAgents, swarmSkills } from '../db/schema';
import { SwarmMailbox, expandRecipient } from './mailbox';
import type { MailboxKind } from './types';
import {
  addAgentToSwarm,
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
    addAgent: async (input: AddAgentToSwarmInput): Promise<AddAgentToSwarmResult> => {
      return addAgentToSwarm(input, {
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
      // BUG-V1.1-01-IPC: canonicalise the legacy wildcard `'*'` to the V3
      // group selector `'@all'` at the controller boundary. The mailbox
      // expand-recipient helper accepts both, but persisting `@all` keeps the
      // SQLite row + JSONL mirror filenames aligned with the rest of the V3
      // grammar (`@coordinators`, `@builders`, …) so consumers don't have to
      // special-case the wildcard. `broadcast()` deliberately keeps `'*'` —
      // that envelope is the canonical legacy wire format.
      const toAgent = input.toAgent === '*' ? '@all' : input.toAgent;
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
        toAgent,
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
        writeToPtys(deps, input.swarmId, toAgent, {
          fromAgent: 'operator',
          toAgent,
          body: input.body,
          kind: kind as SwarmMessageKind,
          originalEnvelopeId: message.id,
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

/**
 * Type the SIGMA::* line into the stdin of every agent that resolves from
 * `toAgent`. Resolution flows through `expandRecipient` so V3 group selectors
 * (`@coordinators`, `@builders`, …) reach every member of the role rather
 * than typing into a non-existent "agent" named `@coordinators` (BUG-V1.1-01).
 *
 * BUG-V1.1-12-IPC: when the target row exists but has no `sessionId` (agent
 * never came up), or the underlying PTY refuses the write (process exited),
 * we now persist a `kind:'error_report'` mailbox row so the operator's
 * side-chat surfaces the dead-write instead of silently dropping it.
 */
function writeToPtys(
  deps: SwarmControllerDeps,
  swarmId: string,
  toAgent: string,
  msg: {
    fromAgent: string;
    toAgent: string;
    body: string;
    kind: SwarmMessageKind;
    originalEnvelopeId?: string;
  },
): void {
  const db = getDb();
  const recipientKeys = expandRecipient(swarmId, toAgent);
  if (recipientKeys.length === 0) return;
  const agentRows = db
    .select()
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, swarmId))
    .all();
  const byKey = new Map(agentRows.map((a) => [a.agentKey, a]));
  const line = formatStdinDelivery(msg);
  for (const key of recipientKeys) {
    const a = byKey.get(key);
    if (!a) continue;
    if (!a.sessionId) {
      reportDeadWrite(deps, swarmId, key, 'session-not-found', msg.originalEnvelopeId);
      continue;
    }
    try {
      deps.pty.write(a.sessionId, line);
    } catch {
      reportDeadWrite(deps, swarmId, key, 'pty-dead', msg.originalEnvelopeId);
    }
  }
}

/**
 * Persist an `error_report` envelope when an Operator → agent write target is
 * dead. Best-effort: a failure to append the report does NOT throw, since the
 * caller is already in a fire-and-forget delivery loop.
 */
function reportDeadWrite(
  deps: SwarmControllerDeps,
  swarmId: string,
  targetAgent: string,
  reason: 'session-not-found' | 'pty-dead',
  originalEnvelopeId: string | undefined,
): void {
  void deps.mailbox
    .append({
      swarmId,
      fromAgent: 'operator',
      toAgent: 'operator',
      kind: 'error_report',
      body: `Operator directive could not reach ${targetAgent}: ${reason}`,
      payload: {
        kind: 'runtime',
        message: `pty write failed: ${reason}`,
        targetAgent,
        reason,
        originalEnvelopeId: originalEnvelopeId ?? null,
      },
    })
    .catch(() => {
      /* mailbox queue rejection is non-fatal here */
    });
}
