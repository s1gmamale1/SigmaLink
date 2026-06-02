// @vitest-environment jsdom
//
// RSP-1 (Lane RSP-Shell) — Sidebar per-workspace width persistence + shared
// breakpoint-hook auto-collapse.
//
// Asserts:
//   - Width hydrates from the per-workspace key (`ui.<wsId>.sidebar.width`)
//     when a workspace is active, with read-through fallback to the legacy
//     global key (`app.sidebar.width`).
//   - A drag-commit writes the PER-WORKSPACE key (not the global one).
//   - Changing `wsId` re-hydrates (a different workspace → different width).
//   - With no workspace open (`wsId === null`) it falls back to the legacy
//     global key for both read and write.
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

// Per-workspace kv helper — backed by an in-memory map so read-through fallback
// to the legacy global key is exercised exactly like the real implementation.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
const readWorkspaceUiMock = vi.fn(
  async (wsId: string, panel: string, legacyGlobalKey?: string): Promise<string | null> => {
    const scoped = store.get(`ui.${wsId}.${panel}`);
    if (scoped !== undefined) return scoped;
    if (legacyGlobalKey) return store.get(legacyGlobalKey) ?? null;
    return null;
  },
);
const writeWorkspaceUiMock = vi.fn(async (wsId: string, panel: string, value: string) => {
  store.set(`ui.${wsId}.${panel}`, value);
});
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  workspaceUiKey: (wsId: string, panel: string) => `ui.${wsId}.${panel}`,
  readWorkspaceUi: (...a: [string, string, string?]) => readWorkspaceUiMock(...a),
  writeWorkspaceUi: (...a: [string, string, string]) => writeWorkspaceUiMock(...a),
}));

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
  store.clear();
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
  readWorkspaceUiMock.mockClear();
  writeWorkspaceUiMock.mockClear();
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

describe('Sidebar RSP-1 — per-workspace width persistence', () => {
  it('hydrates width from the per-workspace key when present', async () => {
    store.set('ui.ws-1.sidebar.width', '360');
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('360px');
    expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-1', 'sidebar.width', 'app.sidebar.width');
  });

  it('falls through to the legacy global key when the scoped value is unset', async () => {
    store.set('app.sidebar.width', '300'); // pre-RSP-1 global value
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('300px');
  });

  it('a drag-commit writes the per-workspace key', async () => {
    const { container } = render(<Sidebar />);
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 0 }));
    await act(async () => {});
    window.dispatchEvent(new PointerEvent('pointerup'));

    expect(writeWorkspaceUiMock).toHaveBeenCalledWith('ws-1', 'sidebar.width', '320');
    // Must NOT have written the flat global key for an active workspace.
    expect(kvSetMock).not.toHaveBeenCalledWith('app.sidebar.width', expect.anything());
  });

  it('re-hydrates when wsId changes (different workspace → different width)', async () => {
    store.set('ui.ws-1.sidebar.width', '360');
    store.set('ui.ws-2.sidebar.width', '420');
    const { container, rerender } = render(<Sidebar />);
    await act(async () => {});
    let aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('360px');

    // Switch the active workspace and re-render.
    mockState = { ...mockState, activeWorkspace: ws('ws-2') };
    rerender(<Sidebar />);
    await act(async () => {});
    aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('420px');
  });

  it('falls back to the global key when no workspace is open', async () => {
    mockState = { ...mockState, activeWorkspace: null };
    kvGetMock.mockResolvedValue('260');
    const { container } = render(<Sidebar />);
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('260px');
    expect(kvGetMock).toHaveBeenCalledWith('app.sidebar.width');

    // Drag-commit with no workspace persists to the legacy global key.
    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 0 }));
    await act(async () => {});
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '300');
    expect(writeWorkspaceUiMock).not.toHaveBeenCalled();
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
