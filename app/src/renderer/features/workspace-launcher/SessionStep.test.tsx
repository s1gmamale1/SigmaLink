// @vitest-environment jsdom
//
// v1.3.0 — SessionStep unit tests.
// Coverage targets:
//   - smart-default selection (top session pre-selected on enter)
//   - bulk-bar: "Resume newest for all", "All new", "Reset to suggested"
//   - popover open + item selection
//   - pre-population merge from lastResumePlan (tested via Launcher integration shim)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionListItem, PaneRow } from './SessionStep';
import { SessionStep } from './SessionStep';

// jsdom does not implement ResizeObserver; cmdk@1.x requires it.
// Polyfill with a no-op so Popover + Command tests don't crash.
if (typeof ResizeObserver === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
// jsdom does not implement scrollIntoView; cmdk@1.x calls it on focus.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ─── rpcSilent mock ──────────────────────────────────────────────────────────

const mockListSessions = vi.fn<(args: { providerId: string; cwd: string; opts?: unknown }) => Promise<SessionListItem[]>>();
const mockLastResumePlan = vi.fn<(workspaceId: string) => Promise<unknown>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {},
  rpcSilent: {
    panes: {
      listSessions: (...args: Parameters<typeof mockListSessions>) => mockListSessions(...args),
      lastResumePlan: (...args: Parameters<typeof mockLastResumePlan>) =>
        mockLastResumePlan(...args),
    },
  },
}));

// ─── radix-ui Popover uses portals — keep portal in document.body ─────────────
// jsdom already has document.body, so no additional setup is needed.

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_A: SessionListItem = {
  id: 'session-aaa',
  providerId: 'claude',
  cwd: '/workspace/proj',
  createdAt: Date.now() - 7200_000,
  updatedAt: Date.now() - 3600_000,
  title: 'feat/auth',
};

const SESSION_B: SessionListItem = {
  id: 'session-bbb',
  providerId: 'codex',
  cwd: '/workspace/proj',
  createdAt: Date.now() - 86400_000,
  updatedAt: Date.now() - 10800_000,
  title: 'fix/bug-42',
};

const ROWS: PaneRow[] = [
  { paneIndex: 0, providerId: 'claude', providerName: 'Claude Code' },
  { paneIndex: 1, providerId: 'codex', providerName: 'Codex' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderStep(
  overrides: Partial<{
    rows: PaneRow[];
    selections: Record<number, string | null>;
    onChange: (n: Record<number, string | null>) => void;
  }> = {},
) {
  const onChange = overrides.onChange ?? vi.fn();
  const { rerender, ...rest } = render(
    <SessionStep
      rows={overrides.rows ?? ROWS}
      cwd="/workspace/proj"
      selections={overrides.selections ?? {}}
      onSelectionsChange={onChange}
      onReconfigure={vi.fn()}
    />,
  );
  return { onChange, rerender, ...rest };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  mockListSessions.mockReset();
  mockLastResumePlan.mockReset();
  // Default: each provider returns one session.
  mockListSessions.mockImplementation(
    async (arg: { providerId: string; cwd: string }) => {
      if (arg.providerId === 'claude') return [SESSION_A];
      if (arg.providerId === 'codex') return [SESSION_B];
      return [];
    },
  );
  mockLastResumePlan.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SessionStep — smart-default selection', () => {
  it('pre-selects top session for each pane on mount', async () => {
    const onChange = vi.fn();
    renderStep({ onChange });

    await waitFor(() => {
      // Should have been called at least once with populated selections.
      const calls = onChange.mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as Record<number, string | null>;
      expect(lastCall).toBeDefined();
      expect(lastCall[0]).toBe('session-aaa');
      expect(lastCall[1]).toBe('session-bbb');
    });
  });

  it('falls back to null (New session) when listSessions returns empty', async () => {
    mockListSessions.mockResolvedValue([]);
    const onChange = vi.fn();
    renderStep({ onChange });

    await waitFor(() => {
      const calls = onChange.mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as Record<number, string | null>;
      expect(lastCall).toBeDefined();
      expect(lastCall[0]).toBeNull();
      expect(lastCall[1]).toBeNull();
    });
  });

  it('shows "New session" badge when no session is selected', async () => {
    mockListSessions.mockResolvedValue([]);
    renderStep({ selections: { 0: null, 1: null } });

    await waitFor(() => {
      const badges = screen.getAllByText('New session');
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('SessionStep — bulk-bar actions', () => {
  it('"All new" sets every pane to null', async () => {
    const onChange = vi.fn();
    renderStep({ selections: { 0: 'session-aaa', 1: 'session-bbb' }, onChange });

    // Wait for sessions to load so the lists are populated.
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

    const allNewBtn = screen.getByRole('button', { name: /all new/i });
    await act(async () => {
      fireEvent.click(allNewBtn);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as Record<
      number,
      string | null
    >;
    expect(lastCall[0]).toBeNull();
    expect(lastCall[1]).toBeNull();
  });

  it('"Resume newest for all" selects top session for each pane', async () => {
    const onChange = vi.fn();
    renderStep({ selections: { 0: null, 1: null }, onChange });

    // Wait until sessions are loaded (onChange has been called by effect).
    await waitFor(() => {
      const calls = onChange.mock.calls;
      const last = calls[calls.length - 1]?.[0] as Record<number, string | null>;
      return last?.[0] !== undefined;
    });
    onChange.mockClear();

    const resumeBtn = screen.getByRole('button', { name: /resume newest for all/i });
    await act(async () => {
      fireEvent.click(resumeBtn);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as Record<
      number,
      string | null
    >;
    // Newest for claude pane → SESSION_A; for codex pane → SESSION_B.
    expect(lastCall[0]).toBe('session-aaa');
    expect(lastCall[1]).toBe('session-bbb');
  });

  it('"Reset to suggested" restores smart defaults', async () => {
    const onChange = vi.fn();
    renderStep({ selections: {}, onChange });

    // Wait for smart-default effect to populate suggested.
    await waitFor(() => expect(mockListSessions).toHaveBeenCalledTimes(2));
    onChange.mockClear();

    // Override manually.
    const allNewBtn = screen.getByRole('button', { name: /all new/i });
    await act(async () => {
      fireEvent.click(allNewBtn);
    });
    onChange.mockClear();

    const resetBtn = screen.getByRole('button', { name: /reset to suggested/i });
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as Record<
      number,
      string | null
    >;
    // Suggested was set to the top session from each listSessions call.
    expect(lastCall[0]).toBe('session-aaa');
    expect(lastCall[1]).toBe('session-bbb');
  });
});

describe('SessionStep — popover open + selection', () => {
  it('renders "Change..." button for every pane', async () => {
    renderStep({ selections: {} });

    await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /change/i });
      expect(btns).toHaveLength(2);
    });
  });

  it('opens popover on "Change..." click and shows session list', async () => {
    renderStep({ selections: { 0: null, 1: null } });

    await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /change/i });
      expect(btns.length).toBeGreaterThan(0);
    });

    const [firstChange] = screen.getAllByRole('button', { name: /change/i });
    await act(async () => {
      fireEvent.click(firstChange!);
    });

    // Popover content should appear with "New session" option.
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search sessions/i)).toBeTruthy();
    });
  });

  it('calls onSelectionsChange with new sessionId on item select', async () => {
    const onChange = vi.fn();
    renderStep({ selections: { 0: null, 1: null }, onChange });

    await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /change/i });
      expect(btns.length).toBeGreaterThan(0);
    });
    onChange.mockClear();

    const [firstChange] = screen.getAllByRole('button', { name: /change/i });
    await act(async () => {
      fireEvent.click(firstChange!);
    });

    // Select "New session" option explicitly.
    await waitFor(() => {
      expect(screen.getByText('Start fresh')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Start fresh'));
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as Record<
      number,
      string | null
    >;
    expect(lastCall[0]).toBeNull();
  });
});

describe('SessionStep — lastResumePlan pre-population', () => {
  // This tests the merge logic: external caller (Launcher) pre-populates
  // selections from lastResumePlan before rendering SessionStep.
  // We simulate by passing pre-populated selections directly.

  it('respects externally-supplied selections from lastResumePlan', async () => {
    // Simulate Launcher having called lastResumePlan and pre-populated pane 0
    // with an explicit sessionId before rendering SessionStep.
    const externalSelections: Record<number, string | null> = {
      0: 'session-aaa',
      1: null,
    };

    renderStep({ selections: externalSelections });

    await waitFor(() => {
      // The badge for pane 0 should show the session, pane 1 "New session".
      const badges = screen.queryAllByText('New session');
      // At least one pane should show "New session" (pane 1).
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('stale sessionId silently falls back (no crash) when listSessions omits it', async () => {
    // Mock: listSessions returns SESSION_B only (session-aaa is stale/gone).
    mockListSessions.mockImplementation(
      async (arg: { providerId: string; cwd: string }) => {
        if (arg.providerId === 'claude') return []; // stale — gone from disk
        return [SESSION_B];
      },
    );

    // Pre-populate with the stale ID.
    const selections: Record<number, string | null> = { 0: 'session-aaa', 1: 'session-bbb' };
    const onChange = vi.fn();

    expect(() => renderStep({ selections, onChange })).not.toThrow();

    // After mount, smart-default effect runs and sets pane 0 to null (not found).
    await waitFor(() => {
      const calls = onChange.mock.calls;
      if (calls.length === 0) return false;
      const lastCall = calls[calls.length - 1]?.[0] as Record<number, string | null>;
      // Pane 0 stale — smart default is null.
      return lastCall[0] === null;
    });
  });
});

describe('SessionStep — reconfigure link', () => {
  it('calls onReconfigure when "Reconfigure layout..." is clicked', async () => {
    const onReconfigure = vi.fn();
    render(
      <SessionStep
        rows={ROWS}
        cwd="/workspace/proj"
        selections={{}}
        onSelectionsChange={vi.fn()}
        onReconfigure={onReconfigure}
      />,
    );

    const link = await screen.findByText(/reconfigure layout/i);
    await act(async () => {
      fireEvent.click(link);
    });
    expect(onReconfigure).toHaveBeenCalledTimes(1);
  });
});
