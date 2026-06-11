// @vitest-environment jsdom
//
// v1.4.8 packet-02 — Sidebar resize handle coverage.
//
// Asserts:
//   - On mount (expanded), kv.get is applied to the aside inline style
//   - Drag sequence on the divider updates width + persists via kv.set
//   - CSS transition class is absent during drag (transition-suppression)
//   - Collapsed state: no drag divider rendered; aside has fixed w-14 class
//   - Double-click resets to 240px

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();
const dispatchMock = vi.fn();
// SigmaLink Dev — flow rpc mocks (Phase 14, Task 8).
const openDevMock = vi.fn();
const launchMock = vi.fn();
const listForWorkspaceMock = vi.fn();
const resumeMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (...args: [string]) => kvGetMock(...args),
      set: (...args: [string, string]) => kvSetMock(...args),
    },
    workspaces: {
      open: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      openDev: (...args: []) => openDevMock(...args),
      launch: (...args: [unknown]) => launchMock(...args),
    },
    panes: {
      listForWorkspace: (...args: [string]) => listForWorkspaceMock(...args),
      resume: (...args: [string]) => resumeMock(...args),
    },
  },
}));

vi.mock('@/renderer/components/Monogram', () => ({
  Monogram: ({ size }: { size: number }) => <svg data-testid="monogram" data-size={size} />,
}));

// WorkspacesPanel is mocked to a div that exposes the dev-entry handler as a
// clickable button so flow tests can trigger openDevWorkspaceFlow without the
// real dropdown. Other tests ignore it (they assert on the aside/divider).
vi.mock('./WorkspacesPanel', () => ({
  WorkspacesPanel: ({ onOpenDev }: { onOpenDev?: () => void }) => (
    <div data-testid="workspaces-panel">
      <button type="button" data-testid="open-dev" onClick={() => onOpenDev?.()} />
    </div>
  ),
}));

// DevWorkspaceDialog is mocked to surface its onLaunch via a button so we can
// drive launchDevTerminals; it only renders when `open` is true. The "twice"
// button fires onLaunch twice in one synchronous tick — modelling two rapid
// clicks queued before React flushes the dialog close — to exercise the
// in-flight re-entrancy guard.
vi.mock('./DevWorkspaceDialog', () => ({
  DevWorkspaceDialog: ({
    open,
    onLaunch,
    launching,
  }: {
    open: boolean;
    onLaunch: (n: number) => void;
    launching?: boolean;
  }) =>
    open ? (
      <div data-testid="dev-dialog" data-launching={launching ? 'true' : 'false'}>
        <button type="button" data-testid="dev-launch-4" onClick={() => onLaunch(4)} />
        <button
          type="button"
          data-testid="dev-launch-4-twice"
          onClick={() => {
            onLaunch(4);
            onLaunch(4);
          }}
        />
      </div>
    ) : null,
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

// ---- helpers -------------------------------------------------------------

import { Sidebar } from './Sidebar';

function renderSidebar() {
  return render(<Sidebar />);
}

// ---- tests ---------------------------------------------------------------

describe('Sidebar — v1.4.8 resize handle (expanded state)', () => {
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

  it('renders aside with default width 240px when kv returns null', async () => {
    kvGetMock.mockResolvedValue(null);
    const { container } = renderSidebar();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('240px');
  });

  it('applies persisted width from kv on mount', async () => {
    kvGetMock.mockResolvedValue('360');
    const { container } = renderSidebar();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('360px');
  });

  it('ignores out-of-range kv values and keeps default', async () => {
    kvGetMock.mockResolvedValue('50');
    const { container } = renderSidebar();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('240px');
  });

  it('renders a drag divider when expanded', async () => {
    const { container } = renderSidebar();
    await act(async () => {});
    const divider = container.querySelector('[role="separator"]');
    expect(divider).toBeTruthy();
  });

  it('drag sequence updates width and persists via kv.set', async () => {
    kvGetMock.mockResolvedValue(null);
    const { container } = renderSidebar();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    expect(divider).toBeTruthy();

    // Drag: start at x=0, move +80px → width should be 240+80=320.
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    expect(document.body.dataset.dragging).toBe('true');

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 0 }));
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('320px');

    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(document.body.dataset.dragging).toBeUndefined();
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '320');
  });

  it('suppresses the transition-[width] class while dragging', async () => {
    const { container } = renderSidebar();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    const aside = container.querySelector('aside') as HTMLElement;

    // Before drag: transition class should be present.
    expect(aside.className).toContain('transition-');

    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    await act(async () => {});

    // During drag: transition class should be absent.
    expect(aside.className).not.toContain('transition-');

    window.dispatchEvent(new PointerEvent('pointerup'));
    await act(async () => {});

    // After drag: transition class should be restored.
    expect(aside.className).toContain('transition-');
  });

  it('clamps width to minimum (180px)', async () => {
    const { container } = renderSidebar();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: -500, clientY: 0 }));
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('180px');

    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '180');
  });

  it('clamps width to maximum (480px)', async () => {
    const { container } = renderSidebar();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 0 }));
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('480px');

    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '480');
  });

  it('double-click on divider resets width to 240 and persists it', async () => {
    kvGetMock.mockResolvedValue('400');
    const { container } = renderSidebar();
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('400px');

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.doubleClick(divider);
    await act(async () => {});

    expect(aside.style.width).toBe('240px');
    expect(kvSetMock).toHaveBeenCalledWith('app.sidebar.width', '240');
  });
});

describe('Sidebar — W1 macOS traffic-light spacer (h-8)', () => {
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
    vi.restoreAllMocks();
  });

  it('renders the macOS spacer with h-8 class when PLATFORM_IS_MAC is true', async () => {
    // Reset the module registry so we can re-mock shortcuts with PLATFORM_IS_MAC=true.
    vi.resetModules();

    vi.doMock('@/renderer/lib/shortcuts', () => ({ PLATFORM_IS_MAC: true }));
    vi.doMock('@/renderer/lib/rpc', () => ({
      rpc: {
        kv: {
          get: (...args: [string]) => kvGetMock(...args),
          set: (...args: [string, string]) => kvSetMock(...args),
        },
        workspaces: { open: vi.fn().mockResolvedValue({}), list: vi.fn().mockResolvedValue([]) },
        panes: { listForWorkspace: vi.fn().mockResolvedValue([]) },
      },
    }));
    vi.doMock('@/renderer/components/Monogram', () => ({
      Monogram: ({ size }: { size: number }) => <svg data-testid="monogram" data-size={size} />,
    }));
    vi.doMock('./WorkspacesPanel', () => ({
      WorkspacesPanel: () => <div data-testid="workspaces-panel" />,
    }));
    vi.doMock('@/renderer/lib/drag-region', () => ({
      dragStyle: () => ({}),
      noDragStyle: () => ({}),
    }));
    vi.doMock('@/renderer/app/state', () => ({
      useAppDispatch: () => dispatchMock,
      useAppStateSelector: (sel: (s: unknown) => unknown) => sel(mockState),
    }));

    const { Sidebar: SidebarMac } = await import('./Sidebar');
    const { container } = render(<SidebarMac />);
    await act(async () => {});

    // The spacer is the first div inside the aside (before the logo row).
    // It carries aria-hidden and the h-8 class.
    const spacer = container.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    expect(spacer).not.toBeNull();
    expect(spacer!.className).toContain('h-8');
    expect(spacer!.className).not.toContain('h-7');
  });
});

describe('Sidebar — Stage 4 a11y: aside aria-label', () => {
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
    vi.restoreAllMocks();
  });

  it('aside has aria-label="Sidebar"', async () => {
    const { container } = renderSidebar();
    await act(async () => {});
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute('aria-label')).toBe('Sidebar');
  });
});

describe('Sidebar — DEV-W1: logo toggles sidebar collapse', () => {
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
    vi.restoreAllMocks();
  });

  it('clicking the logo button dispatches sidebarCollapsed toggle', async () => {
    const { getByLabelText } = renderSidebar();
    await act(async () => {});

    const logoBtn = getByLabelText('Toggle sidebar');
    expect(logoBtn.tagName).toBe('BUTTON');

    fireEvent.click(logoBtn);

    // setCollapsed(true) calls dispatch with SET_SIDEBAR_COLLAPSED action.
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_SIDEBAR_COLLAPSED' }),
    );
  });
});

describe('Sidebar — v1.4.8 resize handle (collapsed state)', () => {
  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
    dispatchMock.mockReset();
    mockState = {
      activeWorkspace: null,
      sidebarCollapsed: true,
      openWorkspaces: [],
      workspaces: [],
      sessions: [],
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render a drag divider when collapsed', async () => {
    const { container } = renderSidebar();
    await act(async () => {});
    const divider = container.querySelector('[role="separator"]');
    expect(divider).toBeNull();
  });

  it('aside has w-14 class and no inline width when collapsed', async () => {
    const { container } = renderSidebar();
    await act(async () => {});
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.className).toContain('w-14');
    expect(aside.style.width).toBe('');
  });
});

describe('Sidebar — SigmaLink Dev flow (Phase 14, Task 8)', () => {
  const devWs = { id: 'dev-ws', name: 'SigmaLink Dev', rootPath: '/Users/me', repoMode: 'plain' };

  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
    dispatchMock.mockReset();
    openDevMock.mockReset().mockResolvedValue(devWs);
    launchMock.mockReset().mockResolvedValue({ sessions: [] });
    listForWorkspaceMock.mockReset().mockResolvedValue([]);
    resumeMock.mockReset().mockResolvedValue({ workspaceId: 'dev-ws', resumed: 0, failed: 0 });
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
    vi.restoreAllMocks();
  });

  it('opens the count dialog when the dev workspace has no sessions', async () => {
    listForWorkspaceMock.mockResolvedValue([]); // no panes yet
    const { getByTestId, queryByTestId } = renderSidebar();
    await act(async () => {});

    expect(queryByTestId('dev-dialog')).toBeNull();
    await act(async () => {
      fireEvent.click(getByTestId('open-dev'));
    });

    expect(openDevMock).toHaveBeenCalledTimes(1);
    expect(getByTestId('dev-dialog')).toBeTruthy();
    // It set the active workspace but did NOT route to command room yet.
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: 'dev-ws' }),
    );
    expect(dispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_ROOM', room: 'command' }),
    );
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('resumes existing panes and routes to the command room when sessions exist', async () => {
    const existing = [{ id: 's1', workspaceId: 'dev-ws', providerId: 'shell' }];
    listForWorkspaceMock.mockResolvedValue(existing); // pre-existing panes
    const { getByTestId, queryByTestId } = renderSidebar();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(getByTestId('open-dev'));
    });

    expect(resumeMock).toHaveBeenCalledWith('dev-ws');
    // No dialog — went straight into the workspace.
    expect(queryByTestId('dev-dialog')).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ADD_SESSIONS', sessions: existing }),
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_ROOM', room: 'command' }),
    );
  });

  it('launches N shell panes via workspaces.launch from the dialog', async () => {
    listForWorkspaceMock.mockResolvedValue([]); // forces the dialog open
    launchMock.mockResolvedValue({
      sessions: [{ id: 'p1', workspaceId: 'dev-ws', providerId: 'shell' }],
    });
    const { getByTestId } = renderSidebar();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(getByTestId('open-dev'));
    });
    // Dialog is open; click its (mocked) Launch(4) button.
    await act(async () => {
      fireEvent.click(getByTestId('dev-launch-4'));
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    const plan = launchMock.mock.calls[0]![0] as {
      workspaceId: string;
      preset: number;
      panes: Array<{ paneIndex: number; providerId: string }>;
    };
    expect(plan.workspaceId).toBe('dev-ws');
    expect(plan.preset).toBe(4); // smallest preset step >= 4
    expect(plan.panes).toHaveLength(4);
    expect(plan.panes.every((p) => p.providerId === 'shell')).toBe(true);
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_ROOM', room: 'command' }),
    );
  });

  it('in-flight guard: two rapid Launch fires call workspaces.launch exactly once', async () => {
    // workspaces.launch is ADDITIVE server-side — without the guard a second
    // queued click would submit a second plan → 2N panes.
    listForWorkspaceMock.mockResolvedValue([]); // forces the dialog open
    const { getByTestId } = renderSidebar();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(getByTestId('open-dev'));
    });
    // Fire Launch(4) twice in one synchronous tick (see the dialog mock) —
    // the first enters launchDevTerminals and suspends at the openDev await;
    // the second must early-return on the in-flight ref.
    await act(async () => {
      fireEvent.click(getByTestId('dev-launch-4-twice'));
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(openDevMock).toHaveBeenCalledTimes(2); // 1× open flow + 1× launch (not 3×)
  });
});
