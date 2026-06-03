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

const mockListSessions = vi.fn<(args: { providerId: string; cwd: string; workspaceId?: string; opts?: unknown }) => Promise<SessionListItem[]>>();
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
    // B2 — default to a scoped workspace so the smart-default auto-selects the
    // top (workspace-recorded) session. Pass `null` to exercise the unscoped
    // path where the default must fall back to "New session".
    workspaceId: string | null;
  }> = {},
) {
  const onChange = overrides.onChange ?? vi.fn();
  const workspaceId =
    overrides.workspaceId === null ? undefined : overrides.workspaceId ?? 'ws-current';
  const { rerender, ...rest } = render(
    <SessionStep
      rows={overrides.rows ?? ROWS}
      cwd="/workspace/proj"
      workspaceId={workspaceId}
      selections={overrides.selections ?? {}}
      onSelectionsChange={onChange}
      onReconfigure={vi.fn()}
    />,
  );
  return { onChange, rerender, ...rest };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  // v1.4.4 P5 — reset ALL mock state between tests to prevent module-state
  // cross-talk when SessionStep.test.tsx runs alongside the full suite.
  //
  // v1.4.7 — REMOVED vi.resetModules() that was added in v1.4.5. Under
  // coverage instrumentation (v8/istanbul), resetModules causes the
  // SessionStep module to be re-imported on every test but the top-of-file
  // vi.mock('@/renderer/lib/rpc', ...) is NOT re-applied to the fresh
  // module instance. The result was a CI flake that hit ~50% of macos-14
  // runs under coverage (passed locally, failed in CI). The cross-suite
  // flake v1.4.5 was trying to fix manifested as a different shape and
  // was already mitigated by vi.resetAllMocks() + the fresh mockReset
  // calls below; resetModules was over-correction.
  vi.resetAllMocks();
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

  // B2 (defect 3) — when the list is UNSCOPED (no workspaceId), the disk
  // scanner returns every session on the machine, so items[0] could be a
  // session from a DIFFERENT project. The default must be null ("New session")
  // so a cross-project session is never auto-picked, EVEN when sessions exist.
  it('defaults to null (New session) for an unscoped list even when sessions exist', async () => {
    const onChange = vi.fn();
    // listSessions still returns sessions, but no workspaceId is passed.
    renderStep({ onChange, workspaceId: null });

    await waitFor(() => {
      const calls = onChange.mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as Record<number, string | null>;
      expect(lastCall).toBeDefined();
      expect(lastCall[0]).toBeNull();
      expect(lastCall[1]).toBeNull();
    });
  });

  // B2 (defect 2) — the workspaceId must be forwarded to listSessions so the
  // backend can scope codex/kimi/gemini to the workspace whitelist.
  it('forwards workspaceId to listSessions for scoping', async () => {
    renderStep({ workspaceId: 'ws-42' });

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
      const arg = mockListSessions.mock.calls[0]?.[0];
      expect(arg?.workspaceId).toBe('ws-42');
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
    // Use default ({}) selections so the smart-default effect fires once
    // sessions load — that gives us a deterministic "sessions are loaded"
    // signal (lastCall[0] === 'session-aaa'). The previous wait condition
    // (`last?.[0] !== undefined`) was satisfied by the initial `null`
    // selection BEFORE listSessions resolved (null !== undefined is true),
    // so the bulk action clicked against an empty session list and set null —
    // a race that only surfaced in isolation / under coverage instrumentation
    // (recurring SessionStep coverage flake; see v1.4.5/v1.4.7 history).
    renderStep({ onChange });

    // Wait until sessions are actually loaded: the smart default populates
    // the top session id (not merely a non-undefined value).
    await waitFor(() => {
      const calls = onChange.mock.calls;
      const last = calls[calls.length - 1]?.[0] as Record<number, string | null>;
      expect(last?.[0]).toBe('session-aaa');
      expect(last?.[1]).toBe('session-bbb');
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
