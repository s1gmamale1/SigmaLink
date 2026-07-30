// Observed-process RAM-brake budget. Unlike `admission.ts` (which counts the
// agent_sessions rows the launch is ABOUT to add), this checks the LIVE OS
// footprint of already-running panes: their resident-set size and how many
// distinct claude-flow stdio MCP server chains each session has spawned. The
// launcher runs this as a preflight so a launch is blocked BEFORE any worktree
// or PTY side effect when the machine is already over budget.
//
// FAIL-OPEN by construction: an unsupported/empty snapshot has `rssBytes: 0`
// and no nodes, so it contributes zero RSS and zero MCP chains and can never
// trip a violation. No platform branching is needed here.

import type { ProcessTreeSnapshot } from '../process/process-tree';
import { summarizeMcpProcesses } from './mcp-process-diagnostic';
import {
  OBSERVED_PROCESS_BUDGET_ERROR_PREFIX,
  type ObservedProcessBudgetCaps,
  type ObservedProcessBudgetDetails,
} from '../../../shared/ram-brake';

// The marker + wire shape live in `shared/` so the renderers can parse what this
// module throws (PR #251 review finding 1). Re-exported here so this module's
// existing public surface is unchanged — mirrors `admission.ts`.
export {
  OBSERVED_PROCESS_BUDGET_ERROR_PREFIX,
  type ObservedProcessBudgetCaps,
  type ObservedProcessBudgetDetails,
} from '../../../shared/ram-brake';

export interface ObservedSessionProcess {
  sessionId: string;
  /**
   * Owning workspace, or `undefined` for sessions that don't carry one (legacy
   * panes, scratch shells, swarm panes). Undefined sessions count ONLY toward
   * `totalRssBytes`, never toward a specific workspace's RSS — so an unrelated
   * session can't consume the launching workspace's budget.
   */
  workspaceId: string | undefined;
  snapshot: ProcessTreeSnapshot | null;
}
export class ObservedProcessBudgetError extends Error {
  readonly details: ObservedProcessBudgetDetails;
  constructor(details: ObservedProcessBudgetDetails) {
    super(`${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}${JSON.stringify(details)}`);
    this.name = 'ObservedProcessBudgetError';
    this.details = details;
  }
}
export function checkObservedProcessBudget(input: {
  workspaceId: string;
  sessions: ObservedSessionProcess[];
  caps: ObservedProcessBudgetCaps;
  force?: boolean;
}): ObservedProcessBudgetDetails {
  const totalRssBytes = input.sessions.reduce((sum, s) => sum + (s.snapshot?.rssBytes ?? 0), 0);
  // Sessions belonging to the launching workspace. Everything scoped below uses
  // this list so the `ObservedSessionProcess.workspaceId` guarantee — "an
  // unrelated session can't consume the launching workspace's budget" — holds
  // for BOTH dimensions, not just RSS. An unscoped duplicate-stdio scan meant
  // one leaking pane in workspace A hard-blocked every launch in workspace B.
  const ownSessions = input.sessions.filter((s) => s.workspaceId === input.workspaceId);
  const workspaceRssBytes = ownSessions.reduce((sum, s) => sum + (s.snapshot?.rssBytes ?? 0), 0);
  const duplicateStdioMcpSessionIds = ownSessions
    .filter((s) => summarizeMcpProcesses(s.snapshot).claudeFlowStdioCount > input.caps.maxClaudeFlowStdioPerSession)
    .map((s) => s.sessionId);
  const violations: ObservedProcessBudgetDetails['violations'] = [];
  if (workspaceRssBytes > input.caps.maxWorkspaceRssBytes) violations.push('workspace-rss');
  if (totalRssBytes > input.caps.maxTotalRssBytes) violations.push('total-rss');
  if (duplicateStdioMcpSessionIds.length > 0) violations.push('duplicate-stdio-mcp');
  const details: ObservedProcessBudgetDetails = {
    kind: 'observed-process-budget',
    caps: input.caps,
    current: { workspaceRssBytes, totalRssBytes, duplicateStdioMcpSessionIds },
    violations,
  };
  if (!input.force && violations.length > 0) throw new ObservedProcessBudgetError(details);
  return details;
}
