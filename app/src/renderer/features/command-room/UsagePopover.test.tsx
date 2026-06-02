// @vitest-environment jsdom
//
// P6 FEAT-3 — UsagePopover coverage.
//
// Asserts:
//   - fetches usage via rpc.usage.sessionSummary({ sessionId }) on mount
//   - renders the token breakdown + formatted $cost + turn count when the
//     session has recorded turns
//   - shows the graceful empty state when there are no turns (turnCount 0) —
//     the common case for non-Claude / raw-terminal panes
//   - treats an RPC rejection as no-data (empty state, never throws)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { UsageSummary, UsageWeekSummary } from '@/shared/types';

const sessionSummaryMock =
  vi.fn<(input: { sessionId: string }) => Promise<UsageSummary>>();
const weekSummaryMock =
  vi.fn<(input: { workspaceId: string }) => Promise<UsageWeekSummary>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    usage: {
      sessionSummary: (...a: [{ sessionId: string }]) => sessionSummaryMock(...a),
      weekSummary: (...a: [{ workspaceId: string }]) => weekSummaryMock(...a),
    },
  },
}));

import { UsagePopover } from './UsagePopover';

const EMPTY_WEEK: UsageWeekSummary = { weekStartMs: 0, byProvider: [] };

const POPULATED: UsageSummary = {
  inputTokens: 12_345,
  outputTokens: 6_789,
  cacheCreationTokens: 100,
  cacheReadTokens: 2_000,
  totalCostUsd: 0.0123,
  turnCount: 3,
};

const EMPTY: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalCostUsd: null,
  turnCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionSummaryMock.mockResolvedValue(POPULATED);
  weekSummaryMock.mockResolvedValue(EMPTY_WEEK);
});

afterEach(() => cleanup());

async function renderPopover(sessionId = 's1', workspaceId = 'ws1') {
  await act(async () => {
    render(<UsagePopover session={{ id: sessionId, workspaceId }} />);
  });
}

describe('UsagePopover', () => {
  it('fetches usage for the session id on mount', async () => {
    await renderPopover('sess-42');
    await waitFor(() => expect(screen.getByTestId('usage-body')).toBeTruthy());
    expect(sessionSummaryMock).toHaveBeenCalledWith({ sessionId: 'sess-42' });
  });

  it('renders the token breakdown, turn count, and formatted cost', async () => {
    await renderPopover();
    await waitFor(() => expect(screen.getByTestId('usage-body')).toBeTruthy());
    // thousands-separated tokens
    expect(screen.getByText('12,345 tok')).toBeTruthy();
    expect(screen.getByText('6,789 tok')).toBeTruthy();
    expect(screen.getByText('2,000 tok')).toBeTruthy();
    // turn count pluralised
    expect(screen.getByText('3 turns')).toBeTruthy();
    // cost trimmed to 4 dp, trailing zeros removed
    expect(screen.getByTestId('usage-cost').textContent).toBe('$0.0123');
  });

  it('shows the empty state when there are no recorded turns', async () => {
    sessionSummaryMock.mockResolvedValue(EMPTY);
    await renderPopover();
    await waitFor(() => expect(screen.getByTestId('usage-empty')).toBeTruthy());
    expect(screen.queryByTestId('usage-body')).toBeNull();
    expect(screen.getByTestId('usage-empty').textContent).toMatch(/no usage data/i);
  });

  it('renders an em-dash cost when turns exist but no priced turn was recorded', async () => {
    sessionSummaryMock.mockResolvedValue({ ...POPULATED, totalCostUsd: null });
    await renderPopover();
    await waitFor(() => expect(screen.getByTestId('usage-body')).toBeTruthy());
    expect(screen.getByTestId('usage-cost').textContent).toBe('—');
  });

  it('falls back to the empty state when the RPC rejects (never throws)', async () => {
    sessionSummaryMock.mockRejectedValue(new Error('boom'));
    weekSummaryMock.mockRejectedValue(new Error('boom'));
    await renderPopover();
    await waitFor(() => expect(screen.getByTestId('usage-empty')).toBeTruthy());
  });

  it('renders workspace week-to-date bars when the week summary has providers', async () => {
    sessionSummaryMock.mockResolvedValue(EMPTY);
    weekSummaryMock.mockResolvedValue({
      weekStartMs: 0,
      byProvider: [
        { providerId: 'claude', totalCostUsd: 1.5, inputTokens: 1000, outputTokens: 500, turnCount: 4 },
        { providerId: 'codex', totalCostUsd: 0.25, inputTokens: 200, outputTokens: 100, turnCount: 1 },
      ],
    });
    await renderPopover('s1', 'ws-7');
    await waitFor(() => expect(screen.getByTestId('usage-week')).toBeTruthy());
    expect(weekSummaryMock).toHaveBeenCalledWith({ workspaceId: 'ws-7' });
    // total of the two providers, formatted
    expect(screen.getByTestId('usage-week').textContent).toMatch(/\$1\.75/);
  });
});
