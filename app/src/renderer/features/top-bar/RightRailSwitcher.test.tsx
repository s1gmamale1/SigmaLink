// @vitest-environment jsdom
//
// SigmaLink v1.1.4 Step 3: verifies the right-edge breadcrumb cluster.
//  - All three segments render and clicking each updates the
//    `RightRailContext` active tab (asserted via aria-selected).
//  - The settings gear dispatches a `SET_ROOM` action with room === 'settings'
//    against `useAppState()`.
//
// We mock the renderer RPC + state modules so the assertions never reach the
// production RPC or reducer. The production `RightRailProvider` is wrapped
// around the component under test.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Mock the renderer RPC layer so RightRailContext's kv hydrate is a no-op.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { set: vi.fn().mockResolvedValue(undefined) } },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
}));

// Capture dispatches from RightRailSwitcher's `useAppState().dispatch`.
const dispatchSpy = vi.fn();

vi.mock('@/renderer/app/state', () => {
  return {
    useAppState: () => ({
      state: {},
      dispatch: dispatchSpy,
    }),
  };
});

// Mock the drag-region helpers to keep tests environment-agnostic.
vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

import { RightRailProvider } from '@/renderer/features/right-rail/RightRailContext';
import { RightRailSwitcher } from './RightRailSwitcher';

function renderSwitcher() {
  return render(
    <RightRailProvider>
      <RightRailSwitcher />
    </RightRailProvider>,
  );
}

describe('RightRailSwitcher', () => {
  beforeEach(() => {
    dispatchSpy.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders three segment buttons + a settings gear', () => {
    renderSwitcher();

    expect(screen.getByRole('tab', { name: 'Browser' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Sigma' })).toBeTruthy();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });

  it('marks the active segment via aria-selected and updates on click', () => {
    renderSwitcher();

    // Default tab is 'browser'.
    const browserTab = screen.getByRole('tab', { name: 'Browser' });
    const editorTab = screen.getByRole('tab', { name: 'Editor' });
    const sigmaTab = screen.getByRole('tab', { name: 'Sigma' });
    expect(browserTab.getAttribute('aria-selected')).toBe('true');
    expect(editorTab.getAttribute('aria-selected')).toBe('false');
    expect(sigmaTab.getAttribute('aria-selected')).toBe('false');

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
});
