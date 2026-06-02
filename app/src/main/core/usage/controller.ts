// P6 FEAT-3 — usage / cost controller.
//
// Dependency-injected factory (mirrors checkpoint-controller.ts). rpc-router
// builds it with the live `getDb` and exposes it as the `usage` namespace.
// The renderer reads per-pane (sessionSummary) and per-workspace week-to-date
// (weekSummary) rollups for the FEAT-3 cost panel + budget bars.

import { sessionSummary as daoSessionSummary, weekSummary as daoWeekSummary } from './dao';
import type { getDb } from '../db/client';
import type { UsageSummary, UsageWeekSummary } from '../../../shared/types';

export type UsageDb = ReturnType<typeof getDb>;

export interface UsageControllerDeps {
  getDb: () => UsageDb;
}

/** Epoch ms of 7 days ago — the week-to-date aggregation window start. */
function weekStart(nowMs: number): number {
  return nowMs - 7 * 24 * 60 * 60 * 1000;
}

export function buildUsageController(deps: UsageControllerDeps) {
  return {
    sessionSummary: async (input: { sessionId: string }): Promise<UsageSummary> =>
      daoSessionSummary(deps.getDb(), input.sessionId),

    weekSummary: async (input: { workspaceId: string }): Promise<UsageWeekSummary> =>
      daoWeekSummary(deps.getDb(), input.workspaceId, weekStart(Date.now())),
  };
}
