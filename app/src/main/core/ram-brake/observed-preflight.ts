// Shared OBSERVED-process RAM-brake preflight.
//
// Whereas `admission.ts` counts the `agent_sessions` rows a launch is ABOUT to
// add, this inspects the LIVE OS footprint of already-running panes: resident-set
// size, and how many distinct claude-flow stdio MCP server chains each pane has
// leaked. It runs BEFORE any worktree/PTY side effect so an over-budget machine
// is blocked before anything mutates.
//
// WHY IT LIVES HERE (C-061): the preflight was inlined in
// `workspaces/launcher.ts`, so the `+ Pane` path (`swarms/factory-add-agent.ts`)
// had no hold at all — a workspace correctly blocked from a full launch could
// still spawn another leaky agent one pane at a time, growing the exact
// multiplier this brake exists to contain. `factory-add-agent` cannot import
// `workspaces/launcher` (launcher → rpc-router → factory → factory-add-agent is
// a cycle; see the `pty/crash` extraction at launcher.ts for the same problem
// solved the same way), so the shared logic moved down here into a leaf module
// that imports nothing but its own sibling and a type. ONE inspection path, two
// callers — a second copy is how the two brakes would drift.
//
// FAIL-OPEN by construction, at every layer:
//   * a per-session snapshot that rejects → `null` → contributes 0 RSS / 0 chains
//   * an unsupported platform → empty snapshot → same
//   * `ramBrake.observedEnabled = 0` → the whole preflight is skipped, snapshots
//     included (see `observedBrakeEnabled`)
// Process inspection being unavailable must never block a launch or an add.

import type Database from 'better-sqlite3';
import type { ProcessTreeSnapshot } from '../process/process-tree';
import { checkObservedProcessBudget } from './process-budget';
import type { ObservedProcessBudgetCaps } from '../../../shared/ram-brake';

/**
 * The slice of `PtyRegistry` this preflight needs. Structural so both callers
 * pass their real registry and tests pass a plain object.
 */
export interface ObservedPreflightPty {
  list(): ReadonlyArray<{ id: string; workspaceId?: string }>;
  processSnapshotCached(id: string): Promise<ProcessTreeSnapshot | null>;
}

const KV_OBSERVED_ENABLED = 'ramBrake.observedEnabled';

/** Default caps — generous: one healthy stdio MCP server per session is fine. */
const DEFAULT_MAX_WORKSPACE_RSS_MB = 4096;
const DEFAULT_MAX_TOTAL_RSS_MB = 12_288;
const DEFAULT_MAX_CLAUDE_FLOW_STDIO_PER_SESSION = 1;

const KV_MAX_WORKSPACE_RSS_MB = 'ramBrake.maxObservedWorkspaceRssMb';
const KV_MAX_TOTAL_RSS_MB = 'ramBrake.maxObservedTotalRssMb';
const KV_MAX_CLAUDE_FLOW_STDIO = 'ramBrake.maxClaudeFlowStdioPerSession';

/**
 * Read a positive-integer KV cap.
 *
 * C-065 — a value the operator explicitly SET but we reject (`0`, a negative, a
 * float, a typo) used to fall back to the default in total silence, so
 * `maxClaudeFlowStdioPerSession = 0` read as `1` and the operator had no way to
 * tell. Rejecting loudly is the cheap fix: the warn only fires on a
 * misconfiguration, names the key, the rejected value, and the fallback, and
 * points at the real kill switch. An ABSENT key stays silent — that is the
 * normal case, not a mistake.
 */
function readPositiveIntKv(db: Database.Database, key: string, fallback: number): number {
  let raw: string | undefined;
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    raw = row?.value;
  } catch {
    return fallback;
  }
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(
    `[ram-brake] ignoring kv['${key}'] = ${JSON.stringify(raw)}: observed-budget caps must be ` +
      `positive integers, so the default (${fallback}) applies. A 0 does NOT disable the brake — ` +
      `set kv['${KV_OBSERVED_ENABLED}'] = 0 for that.`,
  );
  return fallback;
}

function readPositiveBytesKv(db: Database.Database, key: string, fallbackMb: number): number {
  return readPositiveIntKv(db, key, fallbackMb) * 1024 * 1024;
}

/** RAM-brake observed-process budget caps, read from KV with generous defaults. */
export function observedBudgetCaps(db: Database.Database): ObservedProcessBudgetCaps {
  return {
    maxWorkspaceRssBytes: readPositiveBytesKv(
      db,
      KV_MAX_WORKSPACE_RSS_MB,
      DEFAULT_MAX_WORKSPACE_RSS_MB,
    ),
    maxTotalRssBytes: readPositiveBytesKv(db, KV_MAX_TOTAL_RSS_MB, DEFAULT_MAX_TOTAL_RSS_MB),
    maxClaudeFlowStdioPerSession: readPositiveIntKv(
      db,
      KV_MAX_CLAUDE_FLOW_STDIO,
      DEFAULT_MAX_CLAUDE_FLOW_STDIO_PER_SESSION,
    ),
  };
}

/**
 * Kill switch for the OBSERVED-process brake (`ramBrake.observedEnabled`).
 * Default ON — absent/unparseable key keeps the brake exactly as it shipped.
 * Set to '0' / 'false' / 'off' to bypass the preflight ENTIRELY (no snapshots
 * taken), which is the only escape when the observed heuristic misfires: the
 * caps are positive-integer-only, so a 0 cap cannot disable anything (C-065).
 */
export function observedBrakeEnabled(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_OBSERVED_ENABLED) as
      | { value?: string }
      | undefined;
    const value = row?.value;
    if (typeof value !== 'string') return true;
    const normalized = value.trim().toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'off');
  } catch {
    return true;
  }
}

/**
 * Enumerate live panes, snapshot each, and run the observed-process budget.
 * Throws `ObservedProcessBudgetError` when over budget (unless `force`).
 *
 * The `observedEnabled` gate lives INSIDE so "disabled" means no process
 * snapshots are taken at all — not "snapshotted and then forgiven" — and so the
 * launch path and the `+ Pane` path cannot drift on when the brake applies.
 */
export async function runObservedProcessPreflight(input: {
  db: Database.Database;
  pty: ObservedPreflightPty;
  workspaceId: string;
  force: boolean;
}): Promise<void> {
  if (!observedBrakeEnabled(input.db)) return;
  const liveSessions = await Promise.all(
    input.pty.list().map(async (session) => ({
      sessionId: session.id,
      // Pass the session's real workspace (or undefined). Sessions without one
      // (legacy panes, scratch shells, swarm panes spawned via factory-spawn,
      // which does not thread it) must NOT be attributed to the requesting
      // workspace — otherwise an unrelated session inflates this workspace's RSS
      // and could falsely block it. Such sessions still count toward the
      // total-RSS cap.
      workspaceId: session.workspaceId,
      // Local fail-open: a snapshot hiccup must never crash a launch or an add,
      // regardless of processSnapshotCached's own error contract. A null
      // snapshot already contributes 0 RSS and 0 MCP chains.
      snapshot: await input.pty.processSnapshotCached(session.id).catch(() => null),
    })),
  );
  checkObservedProcessBudget({
    workspaceId: input.workspaceId,
    sessions: liveSessions,
    caps: observedBudgetCaps(input.db),
    force: input.force,
  });
}
