// @vitest-environment jsdom
//
// C-12 SigmaBench room — renders the run form (prompt + provider checkboxes +
// Run button), kicks `sigmabench.run`, then polls `sigmabench.getRun` and
// renders a provider leaderboard sorted most-isolated-first.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Mock the rpc module — the room reaches rpc.sigmabench.{run,getRun,listRuns}.
const runMock = vi.fn();
const getRunMock = vi.fn();
const listRunsMock = vi.fn();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    sigmabench: {
      run: (...a: unknown[]) => runMock(...a),
      getRun: (...a: unknown[]) => getRunMock(...a),
      listRuns: (...a: unknown[]) => listRunsMock(...a),
    },
  },
  rpcSilent: {
    sigmabench: {
      getRun: (...a: unknown[]) => getRunMock(...a),
    },
  },
}));

// Mock useAppState so the room has an active workspace.
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { room: 'sigmabench', activeWorkspace: { id: 'ws-1', name: 'WS' } },
  }),
}));

import { SigmaBenchRoom } from './SigmaBenchRoom';

beforeEach(() => {
  runMock.mockReset();
  getRunMock.mockReset();
  listRunsMock.mockReset();
  listRunsMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SigmaBenchRoom', () => {
  it('renders the task prompt textarea, provider checkboxes, and a run button', () => {
    render(<SigmaBenchRoom />);
    expect(screen.getByRole('textbox', { name: /task prompt/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /claude/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /codex/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /gemini/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /run benchmark/i })).toBeTruthy();
  });

  it('calls sigmabench.run with the prompt and selected providers on click', async () => {
    runMock.mockResolvedValue({ runId: 'run-1' });
    // After kicking the run, getRun returns a done run so polling settles.
    getRunMock.mockResolvedValue({
      id: 'run-1',
      status: 'done',
      category: 'multi-agent-conflict',
      taskPrompt: 'do it',
      createdAt: 0,
      results: [],
    });

    render(<SigmaBenchRoom />);
    const textarea = screen.getByRole('textbox', { name: /task prompt/i });
    fireEvent.change(textarea, { target: { value: 'do it' } });
    fireEvent.click(screen.getByRole('button', { name: /run benchmark/i }));

    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(runMock).toHaveBeenCalledWith({
      category: 'multi-agent-conflict',
      taskPrompt: 'do it',
      providers: ['claude', 'codex', 'gemini'],
    });
  });

  it('renders a results leaderboard sorted ascending by conflict score', async () => {
    runMock.mockResolvedValue({ runId: 'run-1' });
    getRunMock.mockResolvedValue({
      id: 'run-1',
      status: 'done',
      category: 'multi-agent-conflict',
      taskPrompt: 'do it',
      createdAt: 0,
      results: [
        {
          sessionId: 's-c',
          provider: 'codex',
          changedFiles: ['a.ts', 'b.ts'],
          conflictScore: 2,
          exitCode: 0,
        },
        {
          sessionId: 's-g',
          provider: 'gemini',
          changedFiles: ['c.ts'],
          conflictScore: 0,
          exitCode: 0,
        },
        {
          sessionId: 's-cl',
          provider: 'claude',
          changedFiles: ['a.ts'],
          conflictScore: 1,
          exitCode: 0,
        },
      ],
    });

    render(<SigmaBenchRoom />);
    fireEvent.change(screen.getByRole('textbox', { name: /task prompt/i }), {
      target: { value: 'do it' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run benchmark/i }));

    await waitFor(() => expect(screen.getAllByTestId('bench-result-row').length).toBe(3));

    const rows = screen.getAllByTestId('bench-result-row');
    const cellsOf = (row: HTMLElement) =>
      Array.from(row.querySelectorAll('td')).map((td) => td.textContent?.trim());

    // Sorted most-isolated first: gemini (score 0), claude (1), codex (2).
    // Each row: [provider, changed-file count, conflict score].
    expect(cellsOf(rows[0])).toEqual(['gemini', '1', '0']);
    expect(cellsOf(rows[1])).toEqual(['claude', '1', '1']);
    expect(cellsOf(rows[2])).toEqual(['codex', '2', '2']);
  });

  it('polls getRun while status is running, then stops once done', async () => {
    vi.useFakeTimers();
    runMock.mockResolvedValue({ runId: 'run-1' });
    getRunMock
      .mockResolvedValueOnce({
        id: 'run-1',
        status: 'running',
        category: 'multi-agent-conflict',
        taskPrompt: 'x',
        createdAt: 0,
        results: [],
      })
      .mockResolvedValue({
        id: 'run-1',
        status: 'done',
        category: 'multi-agent-conflict',
        taskPrompt: 'x',
        createdAt: 0,
        results: [],
      });

    render(<SigmaBenchRoom />);
    fireEvent.change(screen.getByRole('textbox', { name: /task prompt/i }), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run benchmark/i }));

    // Drain the initial run() + first getRun().
    await vi.runOnlyPendingTimersAsync();
    const callsAfterFirst = getRunMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Advance the poll interval — a second getRun returns done; polling stops.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    const callsAfterDone = getRunMock.mock.calls.length;
    // Once done, further interval ticks should NOT keep calling getRun.
    await vi.advanceTimersByTimeAsync(6000);
    expect(getRunMock.mock.calls.length).toBe(callsAfterDone);
  });
});
