// @vitest-environment jsdom
//
// C1 glass chrome — asserts that the sidebar <aside> carries sl-glass-heavy
// and that the Breadcrumb strip carries sl-glass-toolbar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();
const dispatchMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (...args: [string]) => kvGetMock(...args),
      set: (...args: [string, string]) => kvSetMock(...args),
    },
    workspaces: {
      open: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
    },
    panes: {
      listForWorkspace: vi.fn().mockResolvedValue([]),
    },
    // Breadcrumb now reads the app version once on mount (minimal brand bar).
    app: { getVersion: vi.fn().mockResolvedValue('0.0.0') },
  },
}));

vi.mock('@/renderer/components/Monogram', () => ({
  Monogram: ({ size }: { size: number }) => <svg data-testid="monogram" data-size={size} />,
}));

vi.mock('./WorkspacesPanel', () => ({
  WorkspacesPanel: () => <div data-testid="workspaces-panel" />,
}));

vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

vi.mock('@/renderer/lib/shortcuts', () => ({
  PLATFORM_IS_MAC: false,
}));

let mockState = {
  activeWorkspace: null as null | { id: string; name: string; rootPath: string; repoMode: string },
  sidebarCollapsed: false,
  openWorkspaces: [] as unknown[],
  workspaces: [] as unknown[],
  sessions: [] as unknown[],
};

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: (sel: (s: unknown) => unknown) => sel(mockState),
}));

// ---- Breadcrumb mocks -------------------------------------------------------

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: (sel: (s: unknown) => unknown) => sel(mockState),
  // Breadcrumb uses useAppState (not useAppStateSelector)
  useAppState: () => ({ state: { activeWorkspace: null, workspaces: [] } }),
}));

vi.mock('@/renderer/features/notifications/NotificationBell', () => ({
  NotificationBell: () => <span data-testid="notification-bell" />,
}));

vi.mock('@/renderer/features/top-bar/RoomsMenuButton', () => ({
  RoomsMenuButton: () => <button data-testid="rooms-menu" />,
}));

vi.mock('@/renderer/features/top-bar/RightRailSwitcher', () => ({
  RightRailSwitcher: () => <div data-testid="right-rail-switcher" />,
}));

vi.mock('@/renderer/components/RufloReadinessPill', () => ({
  RufloReadinessPill: () => <span data-testid="ruflo-pill" />,
}));

vi.mock('@/renderer/lib/platform', () => ({
  IS_WIN32: false,
}));

// ---- imports ---------------------------------------------------------------

import { Sidebar } from './Sidebar';
import { Breadcrumb } from '../top-bar/Breadcrumb';

// ---- tests -----------------------------------------------------------------

describe('C1 glass chrome — Sidebar', () => {
  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
    dispatchMock.mockReset();
    mockState = {
      activeWorkspace: null,
      sidebarCollapsed: false,
      openWorkspaces: [],
      workspaces: [],
      sessions: [],
    };
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1 as unknown as number;
      },
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    delete document.body.dataset.dragging;
    vi.restoreAllMocks();
  });

  it('sidebar <aside> carries sl-glass-heavy', async () => {
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.className).toContain('sl-glass-heavy');
  });

  it('sidebar <aside> carries relative class', async () => {
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.className).toContain('relative');
  });

  it('active workspace footer row carries sl-nav-active', async () => {
    mockState = {
      ...mockState,
      activeWorkspace: {
        id: 'ws-1',
        name: 'MyProject',
        rootPath: '/Users/test/projects/myproject',
        repoMode: 'git',
      },
    };
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const navActive = container.querySelector('.sl-nav-active');
    expect(navActive).not.toBeNull();
  });

  it('sl-nav-active is absent when no active workspace', async () => {
    mockState = { ...mockState, activeWorkspace: null };
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const navActive = container.querySelector('.sl-nav-active');
    expect(navActive).toBeNull();
  });
});

describe('C1 glass chrome — Breadcrumb', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('breadcrumb strip carries sl-glass-toolbar (no active workspace)', async () => {
    const { getByTestId } = render(<Breadcrumb />);
    await act(async () => {});
    const strip = getByTestId('breadcrumb');
    expect(strip.className).toContain('sl-glass-toolbar');
  });
});
