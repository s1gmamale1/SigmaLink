// @vitest-environment jsdom
//
// PERF-3 — render-count assertions for the room-slice consumers.
// Proves that a consumer subscribing to `state.room` only does NOT
// re-render when an unrelated slice (notificationsUnreadCount) changes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
  },
  onEvent: vi.fn(() => () => undefined),
}));

vi.mock('@/renderer/lib/themes', () => ({
  applyTheme: vi.fn(),
  DEFAULT_THEME: 'obsidian',
  isThemeId: vi.fn(() => false),
  applyDensity: vi.fn(),
  DEFAULT_DENSITY: 'comfortable',
  isDensityId: vi.fn(() => false),
  KV_KEYS: { theme: 'app.theme', density: 'app.density' },
  findTheme: vi.fn(() => ({ id: 'obsidian', appearance: 'dark' })),
}));

import { beforeEach } from 'vitest';
import { AppStateProvider, useAppStateSelector } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';

// Stub window.sigma so AppStateProvider's effects don't crash in jsdom.
beforeEach(() => {
  vi.stubGlobal('sigma', {
    testMode: false,
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

// Minimal probe mirroring RoomSwitch's subscription contract.
function RoomProbe({ onRender }: { onRender: () => void }) {
  const room = useAppStateSelector((s) => s.room);
  onRender();
  return <span data-testid="room">{room}</span>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset store to initial state so tests don't bleed into each other.
  appStateStore.setState(initialAppState);
});

// Minimal probe mirroring GlobalMemorySwitcher's subscription contract.
function WsIdProbe({ onRender }: { onRender: () => void }) {
  const wsId = useAppStateSelector((s) => s.activeWorkspaceId);
  onRender();
  return <span data-testid="wsid">{wsId ?? 'none'}</span>;
}

describe('pane reorder E2E test-hook readiness', () => {
  it('does not expose renderer state markers without the preload test-mode capability', async () => {
    const view = render(
      <AppStateProvider>
        <RoomProbe onRender={() => undefined} />
      </AppStateProvider>,
    );

    // Flush mounted effects so an absent marker proves the gate held rather
    // than merely observing the DOM before the acknowledgement effect ran.
    await act(async () => undefined);
    expect(document.documentElement.dataset.sigmaTestStateHooksReady).toBeUndefined();
    expect(document.documentElement.dataset.sigmaTestActiveWorkspaceId).toBeUndefined();
    expect(document.documentElement.dataset.sigmaTestRoom).toBeUndefined();

    view.unmount();
  });

  it('acknowledges readiness and state only when test mode is enabled, then cleans up', async () => {
    Object.assign(window.sigma, { testMode: true });
    expect(document.documentElement.dataset.sigmaTestStateHooksReady).toBeUndefined();
    const view = render(
      <AppStateProvider>
        <RoomProbe onRender={() => undefined} />
      </AppStateProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.sigmaTestStateHooksReady).toBe('true');
    });
    expect(document.documentElement.dataset.sigmaTestActiveWorkspaceId).toBe('');
    expect(document.documentElement.dataset.sigmaTestRoom).toBe('workspaces');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('sigma:test:set-room', { detail: { room: 'command' } }),
      );
    });
    await waitFor(() => {
      expect(document.documentElement.dataset.sigmaTestRoom).toBe('command');
    });

    view.unmount();
    expect(document.documentElement.dataset.sigmaTestStateHooksReady).toBeUndefined();
    expect(document.documentElement.dataset.sigmaTestActiveWorkspaceId).toBeUndefined();
    expect(document.documentElement.dataset.sigmaTestRoom).toBeUndefined();
  });
});

describe('PERF-3: room-slice selector isolation', () => {
  it('a room-only consumer does NOT re-render on an unrelated notificationsUnreadCount change', () => {
    const spy = vi.fn();
    render(
      <AppStateProvider>
        <RoomProbe onRender={spy} />
      </AppStateProvider>,
    );
    const before = spy.mock.calls.length;
    act(() => {
      appStateStore.setState({
        ...appStateStore.getSnapshot(),
        notificationsUnreadCount: 1,
      });
    });
    // room unchanged → no extra re-render from the probe
    expect(spy.mock.calls.length).toBe(before);
  });

  it('a room-only consumer DOES re-render when state.room changes', () => {
    const spy = vi.fn();
    render(
      <AppStateProvider>
        <RoomProbe onRender={spy} />
      </AppStateProvider>,
    );
    const before = spy.mock.calls.length;
    act(() => {
      appStateStore.setState({ ...appStateStore.getSnapshot(), room: 'swarm' });
    });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('PERF-3 A2: GlobalMemorySwitcher wsId+memories slice isolation', () => {
  it('a wsId-only consumer does NOT re-render on APPEND_SWARM_MESSAGE (unrelated)', () => {
    const spy = vi.fn();
    render(
      <AppStateProvider>
        <WsIdProbe onRender={spy} />
      </AppStateProvider>,
    );
    const before = spy.mock.calls.length;
    act(() => {
      // Simulate appending a swarm message — new map reference, same wsId.
      const snap = appStateStore.getSnapshot();
      appStateStore.setState({
        ...snap,
        swarmMessages: { ...snap.swarmMessages, 'swarm-x': [] },
      });
    });
    expect(spy.mock.calls.length).toBe(before);
  });

  it('a wsId-only consumer DOES re-render when activeWorkspaceId changes', () => {
    const spy = vi.fn();
    render(
      <AppStateProvider>
        <WsIdProbe onRender={spy} />
      </AppStateProvider>,
    );
    const before = spy.mock.calls.length;
    act(() => {
      appStateStore.setState({ ...appStateStore.getSnapshot(), activeWorkspaceId: 'ws-new' });
    });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});
