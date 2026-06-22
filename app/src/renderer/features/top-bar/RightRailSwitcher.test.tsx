// @vitest-environment jsdom
//
// SigmaLink v1.1.4 Step 3: verifies the right-edge breadcrumb cluster.
//  - All three segments render and clicking each updates the
//    `RightRailContext` active tab (asserted via aria-selected).
//  - The settings gear dispatches a `SET_ROOM` action with room === 'settings'
//    against `useAppState()`.
//
// DEV-W4: adds tests for the toggle-on-active-tab behavior and railOpen
// persistence via chrome-ui-kv.
//
// We mock the renderer RPC + state modules so the assertions never reach the
// production RPC or reducer. The production `RightRailProvider` is wrapped
// around the component under test.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Mock the renderer RPC layer so RightRailContext's kv hydrate is a no-op.
const kvSetMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { set: (...a: unknown[]) => kvSetMock(...a) } },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
}));

// DEV-W4 — chrome-ui-kv mock for window-scope-aware open state persistence.
const { uiStore } = vi.hoisted(() => ({ uiStore: new Map<string, string>() }));
const readChromeUiMock = vi.fn(
  async (globalKey: string, _panel: string): Promise<string | null> => uiStore.get(globalKey) ?? null,
);
const writeChromeUiMock = vi.fn(async (globalKey: string, _panel: string, value: string) => {
  uiStore.set(globalKey, value);
});
vi.mock('@/renderer/lib/chrome-ui-kv', () => ({
  readChromeUi: (...a: [string, string]) => readChromeUiMock(...a),
  writeChromeUi: (...a: [string, string, string]) => writeChromeUiMock(...a),
}));

// Capture dispatches from RightRailSwitcher's `useAppDispatch()`.
// PERF-3 — the switcher is dispatch-only; it no longer reads any state slice.
const dispatchSpy = vi.fn();

// DEV-W4 — useAppStateSelector needed by RightRailProvider for wsId.
let activeWsId: string | null = 'ws-switcher-1';
vi.mock('@/renderer/app/state', () => {
  return {
    useAppDispatch: () => dispatchSpy,
    useAppStateSelector: (sel: (s: unknown) => unknown) =>
      sel({ activeWorkspace: activeWsId ? { id: activeWsId } : null }),
  };
});

// Mock the drag-region helpers to keep tests environment-agnostic.
vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

import { RightRailProvider } from '@/renderer/features/right-rail/RightRailContext';
import { RightRailSwitcher } from './RightRailSwitcher';

function renderSwitcher(props: Parameters<typeof RightRailSwitcher>[0] = {}) {
  return render(
    <RightRailProvider>
      <RightRailSwitcher {...props} />
    </RightRailProvider>,
  );
}

describe('RightRailSwitcher', () => {
  beforeEach(() => {
    dispatchSpy.mockReset();
    kvSetMock.mockReset().mockResolvedValue(undefined);
    uiStore.clear();
    readChromeUiMock.mockClear();
    writeChromeUiMock.mockClear();
    activeWsId = 'ws-switcher-1';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders segment buttons (Browser / Editor / Jorvis / Skills / Swarm / Sigma) + a settings gear', () => {
    renderSwitcher();

    expect(screen.getByRole('tab', { name: 'Browser' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Jorvis' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Skills' })).toBeTruthy();
    // C-2/C-4 — Swarm tab registered in top-bar switcher.
    expect(screen.getByRole('tab', { name: 'Swarm' })).toBeTruthy();
    // BSP-O1 — Sigma orchestrator panel tab registered in top-bar switcher.
    expect(screen.getByRole('tab', { name: 'Sigma' })).toBeTruthy();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });

  it('marks the active segment via aria-selected and updates on click', () => {
    renderSwitcher();

    // Default tab is 'browser'.
    const browserTab = screen.getByRole('tab', { name: 'Browser' });
    const editorTab = screen.getByRole('tab', { name: 'Editor' });
    const sigmaTab = screen.getByRole('tab', { name: 'Jorvis' });
    const swarmTab = screen.getByRole('tab', { name: 'Swarm' });
    expect(browserTab.getAttribute('aria-selected')).toBe('true');
    expect(editorTab.getAttribute('aria-selected')).toBe('false');
    expect(sigmaTab.getAttribute('aria-selected')).toBe('false');
    expect(swarmTab.getAttribute('aria-selected')).toBe('false');

    act(() => {
      fireEvent.click(editorTab);
    });
    expect(editorTab.getAttribute('aria-selected')).toBe('true');
    expect(browserTab.getAttribute('aria-selected')).toBe('false');

    act(() => {
      fireEvent.click(sigmaTab);
    });
    expect(sigmaTab.getAttribute('aria-selected')).toBe('true');
    expect(editorTab.getAttribute('aria-selected')).toBe('false');

    act(() => {
      fireEvent.click(browserTab);
    });
    expect(browserTab.getAttribute('aria-selected')).toBe('true');
  });

  it('dispatches SET_ROOM with room "settings" when the gear is clicked', () => {
    renderSwitcher();

    const gear = screen.getByLabelText('Settings');
    act(() => {
      fireEvent.click(gear);
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'settings' });
  });

  // ── DEV-W4: toggle-on-active-tab tests ──────────────────────────────────────

  it('DEV-W4: clicking the already-active tab collapses the rail (toggleRail)', async () => {
    renderSwitcher();
    // Resolve any hydration effects.
    await act(async () => {});

    const browserTab = screen.getByRole('tab', { name: 'Browser' });
    // Browser is the default active tab. Clicking it should close the rail.
    // We verify via writeWorkspaceUi being called with 'false'.
    act(() => {
      fireEvent.click(browserTab);
    });

    // toggleRail sets open → false (was true by default).
    expect(writeChromeUiMock).toHaveBeenCalledWith('rightRail.open', 'rightRail.open', 'false');
  });

  it('DEV-W4: clicking a different (inactive) tab switches and opens the rail', async () => {
    renderSwitcher();
    await act(async () => {});

    const editorTab = screen.getByRole('tab', { name: 'Editor' });
    act(() => {
      fireEvent.click(editorTab);
    });

    // Editor becomes active.
    expect(editorTab.getAttribute('aria-selected')).toBe('true');
    // setRailOpen(true) is called — writeChromeUi persists 'true'.
    expect(writeChromeUiMock).toHaveBeenCalledWith('rightRail.open', 'rightRail.open', 'true');
  });

  it('DEV-W4: clicking the active tab twice re-opens then re-closes', async () => {
    renderSwitcher();
    await act(async () => {});

    const browserTab = screen.getByRole('tab', { name: 'Browser' });

    // First click: open → closed (toggleRail toggles to false).
    act(() => {
      fireEvent.click(browserTab);
    });

    // Second click: closed → open.
    act(() => {
      fireEvent.click(browserTab);
    });

    // Two toggleRail calls → 'false' then 'true'.
    const calls = writeChromeUiMock.mock.calls.filter((c) => c[0] === 'rightRail.open');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1][2]).toBe('true');
  });

  it('DEV-W4: railOpen is hydrated from persisted workspace KV on mount', async () => {
    // Pre-seed a closed state via the global key.
    uiStore.set('rightRail.open', 'false');

    renderSwitcher();
    await act(async () => {});

    // readChromeUi should have been called for 'rightRail.open'.
    expect(readChromeUiMock).toHaveBeenCalledWith('rightRail.open', 'rightRail.open');
  });

  // ── Task 5 — showSettings prop ───────────────────────────────────────────

  it('shows the Settings gear by default', () => {
    renderSwitcher({});
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });

  it('hides the Settings gear when showSettings is false', () => {
    renderSwitcher({ showSettings: false });
    expect(screen.queryByLabelText('Settings')).toBeNull();
    // Tab buttons are still present.
    expect(screen.getByLabelText('Jorvis')).toBeTruthy();
  });
});
