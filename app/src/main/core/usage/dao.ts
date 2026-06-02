// P6 FEAT-3 — usage ledger DAO.
//
// Foundation skeleton: real signatures + zero-returns so rpc-router type-checks
// and wires the controller. The FEAT-3 lane implements the bodies against the
// `usage_ledger` table (migration 0029) and adds its own tests. Kept in a
// dependency-injected module (not inlined in rpc-router) because rpc-router
// pulls in Electron + better-sqlite3 and can't load under vitest.

import type { getDb } from '../db/client';
import type { UsageSummary, UsageWeekSummary } from '../../../shared/types';

/** The drizzle DB handle, typed off the live `getDb` return (a test passes a
 *  chainable fake cast through this — better-sqlite3 can't load under vitest). */
export type UsageDb = ReturnType<typeof getDb>;

/** One recorded turn's usage, harvested from the Claude CLI result envelope. */
export interface RecordTurnInput {
  sessionId: string;
  conversationId: string | null;
  providerId: string;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number | null;
  recordedAt: number;
}

const EMPTY_SUMMARY: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalCostUsd: null,
  turnCount: 0,
};

/** Insert one turn's usage row. FEAT-3 lane implements. */
export function recordTurn(_db: UsageDb, _input: RecordTurnInput): void {
  // FEAT-3 lane: INSERT into usage_ledger.
}

/** Sum all turns for one session/pane. FEAT-3 lane implements. */
export function sessionSummary(_db: UsageDb, _sessionId: string): UsageSummary {
  // FEAT-3 lane: SELECT sum(...) WHERE session_id = ?.
  return { ...EMPTY_SUMMARY };
}

/** Week-to-date spend for a workspace, grouped by provider. FEAT-3 lane implements. */
export function weekSummary(
  _db: UsageDb,
  _workspaceId: string,
  sinceMs: number,
): UsageWeekSummary {
  // FEAT-3 lane: SELECT ... WHERE recorded_at >= ? GROUP BY provider_id, joined
  // to agent_sessions for the workspace filter.
  return { weekStartMs: sinceMs, byProvider: [] };
}
