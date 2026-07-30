export const RAM_BRAKE_ERROR_PREFIX = 'RAM_BRAKE_ADMISSION ';

export interface RamBrakeAdmissionDetails {
  kind: 'ram-brake-admission';
  caps: {
    maxTotalLiveAgents: number;
    maxWorkspaceLiveAgents: number;
    maxTotalMcpHeavyAgents: number;
    maxWorkspaceMcpHeavyAgents: number;
  };
  current: {
    totalLiveAgents: number;
    workspaceLiveAgents: number;
    totalMcpHeavyAgents: number;
    workspaceMcpHeavyAgents: number;
  };
  requested: {
    totalAgents: number;
    mcpHeavyAgents: number;
  };
  projected: {
    totalLiveAgents: number;
    workspaceLiveAgents: number;
    totalMcpHeavyAgents: number;
    workspaceMcpHeavyAgents: number;
  };
  violations: Array<'total' | 'workspace' | 'total-heavy' | 'workspace-heavy'>;
}

export function parseRamBrakeAdmissionError(value: unknown): RamBrakeAdmissionDetails | null {
  const message = value instanceof Error ? value.message : String(value);
  const idx = message.indexOf(RAM_BRAKE_ERROR_PREFIX);
  if (idx < 0) return null;
  const raw = message.slice(idx + RAM_BRAKE_ERROR_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<RamBrakeAdmissionDetails>;
    if (parsed.kind !== 'ram-brake-admission') return null;
    if (!Array.isArray(parsed.violations)) return null;
    if (!parsed.caps || !parsed.current || !parsed.requested || !parsed.projected) return null;
    return parsed as RamBrakeAdmissionDetails;
  } catch {
    return null;
  }
}

export function summarizeRamBrakeAdmission(details: RamBrakeAdmissionDetails): string {
  const parts = [
    `${details.projected.totalLiveAgents}/${details.caps.maxTotalLiveAgents} total`,
    `${details.projected.workspaceLiveAgents}/${details.caps.maxWorkspaceLiveAgents} workspace`,
  ];
  if (details.requested.mcpHeavyAgents > 0 || details.projected.totalMcpHeavyAgents > 0) {
    parts.push(
      `${details.projected.totalMcpHeavyAgents}/${details.caps.maxTotalMcpHeavyAgents} heavy`,
      `${details.projected.workspaceMcpHeavyAgents}/${details.caps.maxWorkspaceMcpHeavyAgents} workspace heavy`,
    );
  }
  return parts.join(' · ');
}

// ─── Observed-process budget (the SECOND RAM brake) ──────────────────────────
// `main/core/ram-brake/process-budget.ts` inspects the LIVE OS footprint of
// already-running panes and throws with its own prefix + `kind`. It lives here,
// beside its admission sibling, because BOTH renderers must be able to turn the
// thrown wire message back into an operator-readable hold — and, critically,
// into the `forceRamBrake` escape hatch. Keeping the marker in `shared/` is what
// stops the main-side throw and the renderer-side parse from drifting apart.

export const OBSERVED_PROCESS_BUDGET_ERROR_PREFIX = 'RAM_BRAKE_OBSERVED_PROCESS_BUDGET:';

export interface ObservedProcessBudgetCaps {
  maxWorkspaceRssBytes: number;
  maxTotalRssBytes: number;
  maxClaudeFlowStdioPerSession: number;
}

export interface ObservedProcessBudgetDetails {
  kind: 'observed-process-budget';
  caps: ObservedProcessBudgetCaps;
  current: {
    workspaceRssBytes: number;
    totalRssBytes: number;
    duplicateStdioMcpSessionIds: string[];
  };
  violations: Array<'workspace-rss' | 'total-rss' | 'duplicate-stdio-mcp'>;
}

export function parseObservedProcessBudgetError(
  value: unknown,
): ObservedProcessBudgetDetails | null {
  const message = value instanceof Error ? value.message : String(value);
  // indexOf, not startsWith: the RPC bridge rethrows main-side errors wrapped in
  // "Error invoking remote method '…': Error: <original>", so the marker lands
  // mid-string. Mirrors parseRamBrakeAdmissionError.
  const idx = message.indexOf(OBSERVED_PROCESS_BUDGET_ERROR_PREFIX);
  if (idx < 0) return null;
  const raw = message.slice(idx + OBSERVED_PROCESS_BUDGET_ERROR_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<ObservedProcessBudgetDetails>;
    if (parsed.kind !== 'observed-process-budget') return null;
    if (!Array.isArray(parsed.violations)) return null;
    if (!parsed.caps || !parsed.current) return null;
    if (!Array.isArray(parsed.current.duplicateStdioMcpSessionIds)) return null;
    return parsed as ObservedProcessBudgetDetails;
  } catch {
    return null;
  }
}

const BYTES_PER_GIB = 1024 * 1024 * 1024;

function gib(bytes: number): string {
  return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
}

/**
 * Operator-readable one-liner for an observed-process hold. Mentions ONLY the
 * dimensions that actually tripped, and never leaks the JSON payload — the
 * whole point of the parse is that the wire shape stays off screen.
 */
export function summarizeObservedProcessBudget(details: ObservedProcessBudgetDetails): string {
  const parts: string[] = [];
  if (details.violations.includes('workspace-rss')) {
    parts.push(
      `workspace RAM ${gib(details.current.workspaceRssBytes)} over the ${gib(details.caps.maxWorkspaceRssBytes)} cap`,
    );
  }
  if (details.violations.includes('total-rss')) {
    parts.push(
      `total RAM ${gib(details.current.totalRssBytes)} over the ${gib(details.caps.maxTotalRssBytes)} cap`,
    );
  }
  if (details.violations.includes('duplicate-stdio-mcp')) {
    const n = details.current.duplicateStdioMcpSessionIds.length;
    parts.push(`${n} pane${n === 1 ? '' : 's'} leaking duplicate MCP servers`);
  }
  if (parts.length === 0) return 'no observed RAM violations';
  return parts.join(' · ');
}

// ─── Either brake ────────────────────────────────────────────────────────────
// The two brakes throw distinct wire markers but share ONE renderer flow:
// prompt → "Force" → retry with `forceRamBrake: true`. These helpers are that
// single seam, so neither catch block has to branch on brake identity.

export type RamBrakeHoldDetails = RamBrakeAdmissionDetails | ObservedProcessBudgetDetails;

export function parseRamBrakeHold(value: unknown): RamBrakeHoldDetails | null {
  return parseRamBrakeAdmissionError(value) ?? parseObservedProcessBudgetError(value);
}

export function summarizeRamBrakeHold(details: RamBrakeHoldDetails): string {
  return details.kind === 'observed-process-budget'
    ? summarizeObservedProcessBudget(details)
    : summarizeRamBrakeAdmission(details);
}

/** Convenience: parse + summarise in one step, or null when it isn't a hold. */
export function parseRamBrakeHoldSummary(value: unknown): string | null {
  const details = parseRamBrakeHold(value);
  return details ? summarizeRamBrakeHold(details) : null;
}
