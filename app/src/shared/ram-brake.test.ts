// PR #251 review finding 1 — the observed-process budget error was thrown by
// `main/core/ram-brake/process-budget.ts` with its own prefix and `kind`, but
// NOTHING parsed it. The renderers only knew `parseRamBrakeAdmissionError`, so
// a blocked launch fell through to `setError(message)` and rendered the raw
// `RAM_BRAKE_OBSERVED_PROCESS_BUDGET:{…}` JSON blob — with the "launch anyway"
// escape hatch unreachable (it is only wired from inside the details-gated
// prompt). These tests pin the parser + summariser that make the hold
// operator-readable and the force path reachable.

import { describe, expect, it } from 'vitest';
import {
  OBSERVED_PROCESS_BUDGET_ERROR_PREFIX,
  RAM_BRAKE_ERROR_PREFIX,
  parseObservedProcessBudgetError,
  parseRamBrakeAdmissionError,
  parseRamBrakeHoldSummary,
  summarizeObservedProcessBudget,
  type ObservedProcessBudgetDetails,
  type RamBrakeAdmissionDetails,
} from './ram-brake';

const GIB = 1024 * 1024 * 1024;

function makeObservedDetails(
  overrides: Partial<ObservedProcessBudgetDetails> = {},
): ObservedProcessBudgetDetails {
  return {
    kind: 'observed-process-budget',
    caps: {
      maxWorkspaceRssBytes: 4 * GIB,
      maxTotalRssBytes: 12 * GIB,
      maxClaudeFlowStdioPerSession: 1,
    },
    current: {
      workspaceRssBytes: 5 * GIB,
      totalRssBytes: 6 * GIB,
      duplicateStdioMcpSessionIds: ['sess-leaky'],
    },
    violations: ['workspace-rss', 'duplicate-stdio-mcp'],
    ...overrides,
  };
}

function makeAdmissionDetails(): RamBrakeAdmissionDetails {
  return {
    kind: 'ram-brake-admission',
    caps: {
      maxTotalLiveAgents: 12,
      maxWorkspaceLiveAgents: 8,
      maxTotalMcpHeavyAgents: 2,
      maxWorkspaceMcpHeavyAgents: 1,
    },
    current: {
      totalLiveAgents: 12,
      workspaceLiveAgents: 8,
      totalMcpHeavyAgents: 2,
      workspaceMcpHeavyAgents: 1,
    },
    requested: { totalAgents: 1, mcpHeavyAgents: 0 },
    projected: {
      totalLiveAgents: 13,
      workspaceLiveAgents: 9,
      totalMcpHeavyAgents: 2,
      workspaceMcpHeavyAgents: 1,
    },
    violations: ['total', 'workspace'],
  };
}

describe('parseObservedProcessBudgetError', () => {
  it('parses an Error carrying the observed-budget prefix + payload', () => {
    const details = makeObservedDetails();
    const err = new Error(`${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}${JSON.stringify(details)}`);
    expect(parseObservedProcessBudgetError(err)).toEqual(details);
  });

  it('parses an IPC-wrapped message where the prefix is not at index 0', () => {
    // The RPC bridge rethrows main-side errors with a channel prefix, so the
    // marker lands mid-string — mirroring parseRamBrakeAdmissionError's indexOf.
    const details = makeObservedDetails();
    const err = new Error(
      `Error invoking remote method 'workspaces:launch': Error: ${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}${JSON.stringify(details)}`,
    );
    expect(parseObservedProcessBudgetError(err)?.violations).toEqual([
      'workspace-rss',
      'duplicate-stdio-mcp',
    ]);
  });

  it('returns null for a non-matching string', () => {
    expect(parseObservedProcessBudgetError('Workspace not opened: ws-1')).toBeNull();
    expect(parseObservedProcessBudgetError(new Error('boom'))).toBeNull();
  });

  it('returns null for a malformed payload or a mismatched kind', () => {
    expect(
      parseObservedProcessBudgetError(new Error(`${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}{not json`)),
    ).toBeNull();
    expect(
      parseObservedProcessBudgetError(
        new Error(`${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}${JSON.stringify({ kind: 'other' })}`),
      ),
    ).toBeNull();
  });

  it('does not cross-parse the admission error', () => {
    const admission = new Error(`${RAM_BRAKE_ERROR_PREFIX}${JSON.stringify(makeAdmissionDetails())}`);
    expect(parseObservedProcessBudgetError(admission)).toBeNull();
  });
});

describe('parseRamBrakeAdmissionError', () => {
  it('returns null for the observed-budget error (the two brakes stay distinct)', () => {
    const observed = new Error(
      `${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}${JSON.stringify(makeObservedDetails())}`,
    );
    expect(parseRamBrakeAdmissionError(observed)).toBeNull();
  });
});

describe('summarizeObservedProcessBudget', () => {
  it('renders human-readable text with no JSON braces', () => {
    const text = summarizeObservedProcessBudget(makeObservedDetails());
    expect(text).not.toContain('{');
    expect(text).not.toContain('observed-process-budget');
    expect(text).toContain('5.0');
    expect(text).toContain('4.0');
    expect(text).toMatch(/workspace RAM/i);
    expect(text).toMatch(/MCP/i);
  });

  it('mentions only the violated dimensions', () => {
    const text = summarizeObservedProcessBudget(
      makeObservedDetails({
        current: {
          workspaceRssBytes: 1 * GIB,
          totalRssBytes: 13 * GIB,
          duplicateStdioMcpSessionIds: [],
        },
        violations: ['total-rss'],
      }),
    );
    expect(text).toMatch(/total RAM/i);
    expect(text).not.toMatch(/workspace RAM/i);
    expect(text).not.toMatch(/MCP/i);
  });

  it('still says something when no dimension is over cap (force preview)', () => {
    const text = summarizeObservedProcessBudget(
      makeObservedDetails({
        current: { workspaceRssBytes: 0, totalRssBytes: 0, duplicateStdioMcpSessionIds: [] },
        violations: [],
      }),
    );
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('parseRamBrakeHoldSummary', () => {
  it('summarises an admission hold', () => {
    const err = new Error(`${RAM_BRAKE_ERROR_PREFIX}${JSON.stringify(makeAdmissionDetails())}`);
    expect(parseRamBrakeHoldSummary(err)).toContain('13/12 total');
  });

  it('summarises an observed-process hold', () => {
    const err = new Error(
      `${OBSERVED_PROCESS_BUDGET_ERROR_PREFIX}${JSON.stringify(makeObservedDetails())}`,
    );
    expect(parseRamBrakeHoldSummary(err)).toMatch(/workspace RAM/i);
  });

  it('returns null for any other failure so the raw message still surfaces', () => {
    expect(parseRamBrakeHoldSummary(new Error('Workspace not opened: ws-1'))).toBeNull();
  });
});
