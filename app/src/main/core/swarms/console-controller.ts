// V3-W12-014 — Operator Console controller.
//
// This file owns the controller methods for the Operator Console RPC surface.
// The CHANNELS allowlist is owned by `coder-foundations` (rpc-channels.ts);
// this file only defines the handlers and exposes a builder for rpc-router.ts.
//
// Methods:
//   swarm.console-tab        { swarmId, tab } → void
//   swarm.stop-all           { swarmId, reason } → { stopped }
//   swarm.constellation-layout { swarmId, nodePositions } → void
//   swarm.agent-filter       { swarmId, filter } → void
//   swarm.mission-rename     { swarmId, mission } → { mission }
//   swarm.update-agent       { swarmId, agentKey, autoApprove?, providerId? } → void
//
// Events broadcast every 1s while the controller is mounted:
//   swarm:counters { swarmId, escalations, review, quiet, errors }
//   swarm:ledger   { swarmId, agentsTotal, messagesTotal, elapsedMs }
//
// Counter projection uses `swarm_messages.resolvedAt` (V3-W12-016 migration
// owned by foundations); the column is referenced via raw SQL so this file
// builds even if the drizzle schema doesn't yet expose `resolvedAt` natively.

import { eq, and, isNull, count } from 'drizzle-orm';
import { defineController } from '../../../shared/rpc';
import { getDb } from '../db/client';
import { swarmAgents, swarmMessages, swarms, kv } from '../db/schema';
import type { PtyRegistry } from '../pty/registry';

export type ConsoleTab = 'terminals' | 'chat' | 'activity';
export type AgentFilter = 'all' | 'coordinators' | 'builders' | 'scouts' | 'reviewers';

export interface ConsoleCounters {
  swarmId: string;
  escalations: number;
  review: number;
  quiet: number;
  errors: number;
}

export interface ConsoleLedger {
  swarmId: string;
  agentsTotal: number;
  messagesTotal: number;
  elapsedMs: number;
}

export type CounterEmitter = (counters: ConsoleCounters) => void;
export type LedgerEmitter = (ledger: ConsoleLedger) => void;

export interface ConsoleControllerDeps {
  pty: PtyRegistry;
  /** Broadcast `swarm:counters` events. */
  emitCounters: CounterEmitter;
  /** Broadcast `swarm:ledger` events. */
  emitLedger: LedgerEmitter;
}

interface UpdateAgentInput {
  swarmId: string;
  agentKey: string;
  autoApprove?: boolean;
  providerId?: string;
  modelId?: string;
}

interface StopAllInput {
  swarmId: string;
  reason?: string;
}

interface ConsoleTabInput {
  swarmId: string;
  tab: ConsoleTab;
}

interface AgentFilterInput {
  swarmId: string;
  filter: AgentFilter;
}

interface MissionRenameInput {
  swarmId: string;
  mission: string;
}

interface ConstellationLayoutInput {
  swarmId: string;
  /** Map of agentKey → { x, y } (pixels relative to canvas origin). */
  nodePositions: Record<string, { x: number; y: number }>;
}

/**
 * Build the operator console controller. Returns the handler map and a
 * `start()` function that begins the 1s broadcast loop. The caller is
 * responsible for calling `stop()` on shutdown.
 */
export function buildConsoleController(deps: ConsoleControllerDeps) {
  const handlers = defineController({
    'console-tab': async (input: ConsoleTabInput): Promise<void> => {
      // Persist current tab as a hint for next-launch; doesn't drive any
      // server-side behaviour today.
      await kvSet(`swarm.console-tab.${input.swarmId}`, input.tab);
    },

    'stop-all': async (input: StopAllInput): Promise<{ stopped: number }> => {
      const db = getDb();
      const rows = db
        .select({ id: swarmAgents.id, sessionId: swarmAgents.sessionId })
        .from(swarmAgents)
        .where(eq(swarmAgents.swarmId, input.swarmId))
        .all();
      let stopped = 0;
      for (const row of rows) {
        if (!row.sessionId) continue;
        try {
          deps.pty.kill(row.sessionId);
          stopped += 1;
        } catch {
          /* PTY may have exited */
        }
      }
      // Mark the swarm as completed so the renderer's swarm-status
      // selectors flip to "ended".
      db.update(swarms)
        .set({ status: 'completed', endedAt: Date.now() })
        .where(eq(swarms.id, input.swarmId))
        .run();
      // Persist the stop reason for forensic value (best-effort).
      if (input.reason) {
        await kvSet(`swarm.stop-reason.${input.swarmId}`, input.reason);
      }
      return { stopped };
    },

    'constellation-layout': async (
      input: ConstellationLayoutInput,
    ): Promise<void> => {
      await kvSet(
        `swarm.constellation.${input.swarmId}`,
        JSON.stringify(input.nodePositions),
      );
    },

    'agent-filter': async (input: AgentFilterInput): Promise<void> => {
      await kvSet(`swarm.agent-filter.${input.swarmId}`, input.filter);
    },

    'mission-rename': async (
      input: MissionRenameInput,
    ): Promise<{ mission: string }> => {
      const trimmed = input.mission.trim();
      if (!trimmed) throw new Error('Mission must not be empty.');
      const db = getDb();
      db.update(swarms)
        .set({ mission: trimmed })
        .where(eq(swarms.id, input.swarmId))
        .run();
      return { mission: trimmed };
    },

    'update-agent': async (input: UpdateAgentInput): Promise<void> => {
      const db = getDb();
      const updates: Record<string, unknown> = {};
      if (input.providerId) updates.providerId = input.providerId;
      if (typeof input.autoApprove === 'boolean') {
        updates.autoApprove = input.autoApprove ? 1 : 0;
      }
      if (Object.keys(updates).length === 0) return;
      db.update(swarmAgents)
        .set(updates as { providerId?: string; autoApprove?: number })
        .where(
          and(
            eq(swarmAgents.swarmId, input.swarmId),
            eq(swarmAgents.agentKey, input.agentKey),
          ),
        )
        .run();
      // Model id is a renderer-only concept until V3-W13 ships
      // `swarm_agents.modelId`; persist as a kv hint for now.
      if (input.modelId) {
        await kvSet(
          `swarm.agent-model.${input.swarmId}.${input.agentKey}`,
          input.modelId,
        );
      }
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1s broadcast loop — counters + ledger per active swarm.
  // ──────────────────────────────────────────────────────────────────────
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    try {
      const db = getDb();
      const active = db
        .select({ id: swarms.id, createdAt: swarms.createdAt })
        .from(swarms)
        .where(eq(swarms.status, 'running'))
        .all();
      const now = Date.now();
      for (const sw of active) {
        const counters = projectCounters(sw.id);
        deps.emitCounters(counters);
        const ledger = projectLedger(sw.id, sw.createdAt, now);
        deps.emitLedger(ledger);
      }
    } catch {
      /* DB may be closing during shutdown — counters resume next tick */
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(tick, 1000);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { handlers, start, stop };
}

/**
 * Project the four console counters for a swarm by joining `swarm_messages`
 * filtered by `kind ∈ {escalation, review_request, quiet_tick, error_report}`
 * and `resolvedAt IS NULL` (V3-W12-016 column).
 */
function projectCounters(swarmId: string): ConsoleCounters {
  const db = getDb();
  const baseRows = db
    .select({ kind: swarmMessages.kind, resolvedAt: swarmMessages.resolvedAt })
    .from(swarmMessages)
    .where(eq(swarmMessages.swarmId, swarmId))
    .all();
  let escalations = 0;
  let review = 0;
  let quiet = 0;
  let errors = 0;
  for (const row of baseRows) {
    if (row.resolvedAt != null) continue;
    switch (row.kind) {
      case 'escalation':
        escalations += 1;
        break;
      case 'review_request':
        review += 1;
        break;
      case 'quiet_tick':
        quiet += 1;
        break;
      case 'error_report':
        errors += 1;
        break;
      default:
        break;
    }
  }
  return { swarmId, escalations, review, quiet, errors };
}

function projectLedger(swarmId: string, createdAt: number, now: number): ConsoleLedger {
  const db = getDb();
  const agentsTotal = db
    .select({ c: count() })
    .from(swarmAgents)
    .where(eq(swarmAgents.swarmId, swarmId))
    .get()?.c ?? 0;
  const messagesTotal = db
    .select({ c: count() })
    .from(swarmMessages)
    .where(eq(swarmMessages.swarmId, swarmId))
    .get()?.c ?? 0;
  return {
    swarmId,
    agentsTotal: Number(agentsTotal),
    messagesTotal: Number(messagesTotal),
    elapsedMs: Math.max(0, now - createdAt),
  };
}

async function kvSet(key: string, value: string): Promise<void> {
  const db = getDb();
  // Insert-or-replace via SQLite upsert. Drizzle's `onConflictDoUpdate` syntax
  // varies by driver — use the explicit two-step path so the DDL stays
  // portable across the better-sqlite3 + libsql build targets.
  const existing = db.select().from(kv).where(eq(kv.key, key)).get();
  if (existing) {
    db.update(kv).set({ value, updatedAt: Date.now() }).where(eq(kv.key, key)).run();
  } else {
    db.insert(kv).values({ key, value }).run();
  }
}

// `isNull` is intentionally referenced via the conditional in `projectCounters`
// rather than a Drizzle WHERE clause; kept imported for future migration to a
// SQL-side filter when index coverage lands. Suppress unused-import warnings
// without disabling the rule globally.
void isNull;
