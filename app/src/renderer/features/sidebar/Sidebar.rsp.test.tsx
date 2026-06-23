// @vitest-environment jsdom
//
// Sidebar — universal width (global, not per-workspace) + shared
// breakpoint-hook auto-collapse.
//
// Asserts:
//   - Width hydrates from the GLOBAL key (`app.sidebar.width`) directly via
//     `rpc.kv`, mount-once (no re-read on workspace change).
//   - A drag-commit writes the GLOBAL key (never a per-workspace key).
//   - Width is universal: switching the active workspace does NOT re-hydrate.
//   - Sidebar auto-collapses when `useBelowBreakpoint('compact')` is true.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

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
    panes: { listForWorkspace: vi.fn().mockResolvedValue([]) },
    swarms: { list: vi.fn().mockResolvedValue([]) },
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

vi.mock('@/renderer/lib/shortcuts', () => ({ PLATFORM_IS_MAC: false }));

// Shared breakpoint hook — controllable per test.
let belowCompact = false;
vi.mock('@/renderer/lib/use-breakpoint', () => ({
  useBelowBreakpoint: (name: string) => (name === 'compact' ? belowCompact : false),
}));

type WsState = {
  activeWorkspace: null | { id: string; name: string; rootPath: string; repoMode: string };
  sidebarCollapsed: boolean;
  openWorkspaces: unknown[];
  workspaces: unknown[];
  sessions: unknown[];
};
let mockState: WsState;
vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: (sel: (s: unknown) => unknown) => sel(mockState),
}));

import { Sidebar } from './Sidebar';

function ws(id: string) {
  return { id, name: id, rootPath: `/repo/${id}`, repoMode: 'git' };
}

beforeEach(() => {
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
  dispatchMock.mockReset();
  belowCompact = false;
  mockState = {
    activeWorkspace: ws('ws-1'),
    sidebarCollapsed: false,
    openWorkspaces: [],
    workspaces: [],
    sessions: [],
  };
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(performance.now());
    return 1 as unknown as number;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  delete document.body.dataset.dragging;
  vi.restoreAllMocks();
});

describe('Sidebar — universal width (global, not per-workspace)', () => {
  it('hydrates width from the global key app.sidebar.width', async () => {
    kvGetMock.mockResolvedValue('360');
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('360px');
    expect(kvGetMock).toHaveBeenCalledWith('app.sidebar.width');
  });

  it('a drag-commit writes the global key (never a per-workspace key)', async () => {
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 0 }));
    await act(async () => {});
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '320');
  });

  it('does NOT re-hydrate when the active workspace changes (width is universal)', async () => {
    kvGetMock.mockResolvedValue('360');
    const { container, rerender } = render(<Sidebar />);
    await act(async () => {});
    let aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('360px');

    // Switch the active workspace and make the global key resolve to a NEW value.
    kvGetMock.mockResolvedValue('420');
    mockState = { ...mockState, activeWorkspace: ws('ws-2') };
    rerender(<Sidebar />);
    await act(async () => {});
    aside = container.querySelector('aside') as HTMLElement;
    // Stays 360 — the mount-once effect did not re-read on workspace change.
    expect(aside.style.width).toBe('360px');
  });
});

describe('Sidebar RSP-1 — compact-breakpoint auto-collapse', () => {
  it('dispatches collapse when below the compact breakpoint and not collapsed', async () => {
    belowCompact = true;
    render(<Sidebar />);
    await act(async () => {});
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'SET_SIDEBAR_COLLAPSED', collapsed: true });
  });

  it('does NOT auto-collapse when at/above the compact breakpoint', async () => {
    belowCompact = false;
    render(<Sidebar />);
    await act(async () => {});
    expect(dispatchMock).not.toHaveBeenCalledWith({
      type: 'SET_SIDEBAR_COLLAPSED',
      collapsed: true,
    });
  });

  it('does not re-dispatch collapse when already collapsed (one-way)', async () => {
    belowCompact = true;
    mockState = { ...mockState, sidebarCollapsed: true };
    render(<Sidebar />);
    await act(async () => {});
    expect(dispatchMock).not.toHaveBeenCalledWith({
      type: 'SET_SIDEBAR_COLLAPSED',
      collapsed: true,
    });
  });
});
