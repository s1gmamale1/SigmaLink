// @vitest-environment jsdom
//
// v1.4.3 #05 — CommandRoom EmptyState defensive UX coverage.
//
// The empty-state branch is the actual fix surface for the "+Pane button is
// a triangle box" complaint at CommandRoom.tsx:195-208 (now expanded). When
// the workspace is active but `sessions.length === 0`, the EmptyState
// surfaces an inline "Add first pane" button alongside the legacy
// "Go to Workspaces" CTA — but ONLY when the swarm is running AND providers
// are loaded, so the click can never dead-end.
//
// Also covers a smoke for #06 (cell-grouping): the GridLayout renders one
// cell per split group when sessions share a split_group_id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentSession, Swarm, Workspace } from '@/shared/types';

// ---- mocks ---------------------------------------------------------------
//
// The Terminal subtree pulls in xterm + ResizeObserver; we stub it at the
// module boundary so this suite stays focused on CommandRoom's rendering
// branches without booting the cache machinery.

vi.mock('./Terminal', () => ({
  SessionTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`terminal-${sessionId}`}>terminal:{sessionId}</div>
  ),
}));

// PaneSplash subscribes to the renderer pty-data-bus which assumes
// `window.sigma`; stub it out to a no-op.
vi.mock('./PaneSplash', () => ({
  PaneSplash: () => null,
}));

// WorktreeInfoBanner pulls in `rpc.app.getUserDataPath()` and
// `rpc.app.dismissedWorktreeBanner()` which aren't wired in our rpc mock.
vi.mock('@/renderer/components/WorktreeInfoBanner', () => ({
  WorktreeInfoBanner: () => null,
}));

// The engine/xterm caches attach the label reader; mock it out for the room render.
vi.mock('@/renderer/lib/label-reader', () => ({
  attachEngineLabelReader: vi.fn(),
  attachXtermLabelReader: vi.fn(),
  detachLabelReader: vi.fn(),
}));

const addAgentMock = vi.fn();
const createSwarmMock = vi.fn();
const listProvidersMock = vi.fn();
const listSwarmsMock = vi.fn();
const ptyKillMock = vi.fn();
const ptyWriteMock = vi.fn();
// session-persistence fix (2026-07-18) — relaunch must close the crashed ROW.
const panesCloseMock = vi.fn();
const silentKvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const silentKvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    providers: {
      list: (...args: unknown[]) => listProvidersMock(...args),
    },
    swarms: {
      addAgent: (...args: unknown[]) => addAgentMock(...args),
      create: (...args: unknown[]) => createSwarmMock(...args),
      list: (...args: unknown[]) => listSwarmsMock(...args),
      splitPane: vi.fn(),
      minimisePane: vi.fn(),
    },
    pty: {
      kill: (...args: unknown[]) => ptyKillMock(...args),
      write: (...args: unknown[]) => ptyWriteMock(...args),
    },
    panes: {
      rename: vi.fn(() => Promise.resolve({ ok: true })),
      setDisplayProvider: vi.fn(() => Promise.resolve({ ok: true })),
      brief: vi.fn(() => Promise.resolve()),
      close: (...args: unknown[]) => panesCloseMock(...args),
    },
    git: {
      listCheckpoints: vi.fn(() => Promise.resolve([])),
    },
    usage: {
      sessionSummary: vi.fn(() => Promise.resolve({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: null, turnCount: 0 })),
    },
    app: {
      revealInFolder: vi.fn(),
      openShell: vi.fn(),
    },
    // P6 Cycle-3 — PaneShell reads the prompt-cards opt-in gate on mount (FEAT-4).
    kv: {
      get: vi.fn(() => Promise.resolve(null)),
      set: vi.fn(() => Promise.resolve()),
    },
  },
  rpcSilent: {
    providers: { list: vi.fn(() => Promise.resolve([])) },
    // PaneHeader drag-grip coachmark (FEAT-12) + git-activity strip (FEAT-8) read via rpcSilent.
    kv: {
      get: (key: string) => silentKvGetMock(key),
      set: (key: string, value: string) => silentKvSetMock(key, value),
    },
    git: { activityLog: vi.fn(() => Promise.resolve([])) },
    ruflo: { daemonStatus: vi.fn(() => Promise.resolve([]) ) },
  },
  // BSP-O4: PaneHeader + CheckpointPanel subscribe via onEvent.
  onEvent: vi.fn(() => () => undefined),
}));

// Minimal app-state mock. Each test seeds the slice it cares about via
// `setState`. Dispatch is captured so we can assert SET_ROOM / ADD_SESSIONS
// flows.
let mockState: {
  activeWorkspace: Workspace | null;
  activeWorkspaceId: string | null;
  sessionsByWorkspace: Record<string, AgentSession[]>;
  swarmsByWorkspace: Record<string, Swarm[]>;
  activeSessionId: string | null;
  activeSwarmId: string | null;
  focusedPaneId: string | null;
};
const dispatchMock = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: (selector: (s: unknown) => unknown) => selector(mockState),
}));

// Radix Tooltip / Dropdown need basic Element prototype methods + a
// ResizeObserver stub in jsdom.
beforeEach(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;

  mockState = {
    activeWorkspace: makeWorkspace(),
    activeWorkspaceId: 'ws-1',
    sessionsByWorkspace: {},
    swarmsByWorkspace: { 'ws-1': [makeSwarm('running')] },
    activeSessionId: null,
    activeSwarmId: null,
    focusedPaneId: null,
  };
  dispatchMock.mockReset();
  addAgentMock.mockReset();
  createSwarmMock.mockReset();
  listProvidersMock.mockReset();
  listSwarmsMock.mockReset();
  ptyKillMock.mockReset();
  ptyWriteMock.mockReset();
  panesCloseMock.mockReset();
  panesCloseMock.mockResolvedValue(undefined);
  silentKvGetMock.mockReset();
  silentKvGetMock.mockResolvedValue(null);
  silentKvSetMock.mockReset();
  silentKvSetMock.mockResolvedValue(undefined);
  listProvidersMock.mockResolvedValue([
    { id: 'claude', name: 'Claude' },
    { id: 'codex', name: 'Codex' },
  ]);
  listSwarmsMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeWorkspace(id = 'ws-1'): Workspace {
  return {
    id,
    name: id === 'ws-1' ? 'Workspace 1' : `Workspace ${id}`,
    rootPath: `/tmp/${id}`,
    repoRoot: null,
    repoMode: 'plain',
    createdAt: 0,
    lastOpenedAt: 0,
  };
}

function makeSwarm(status: 'running' | 'paused' | 'completed' | 'failed'): Swarm {
  return {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Swarm 1',
    mission: 'test',
    preset: 'custom',
    status,
    createdAt: 0,
    endedAt: null,
    agents: [],
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/tmp/ws-1',
    branch: null,
    status: 'running',
    startedAt: 0,
    worktreePath: null,
    ...overrides,
  };
}

// Import the component AFTER all mocks are wired so the dynamic state mock
// captures the per-test setup.
async function renderCommandRoom() {
  const { CommandRoom } = await import('./CommandRoom');
  const view = render(<CommandRoom />);
  return {
    ...view,
    rerenderCommandRoom: () => view.rerender(<CommandRoom />),
  };
}

function paneCellIds(): Array<string | null> {
  return screen.getAllByTestId('pane-cell').map((cell) => cell.getAttribute('data-session-id'));
}

function paneOrderKey(workspaceId = 'ws-1'): string {
  return `ui.${workspaceId}.commandRoom.paneOrder`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rect(left: number, top = 0, width = 100, height = 100): DOMRect {
  return {
    x: left,
    y: top,
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockPaneRects(sessionIds: string[]): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      const index = sessionIds.indexOf(this.getAttribute('data-session-id') ?? '');
      return index >= 0 ? rect(index * 100) : rect(0, 0, sessionIds.length * 100, 100);
    },
  );
}

async function keyboardSwap(
  paneName: string,
  position: number,
  count: number,
  direction: 'ArrowLeft' | 'ArrowRight',
): Promise<void> {
  const handle = screen.getByRole('button', {
    name: `Reorder ${paneName}, position ${position} of ${count}`,
  });
  fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
  await screen.findByTestId('pane-reorder-overlay');
  fireEvent.keyDown(document, { key: direction, code: direction });
  fireEvent.keyDown(document, { key: ' ', code: 'Space' });
  await waitFor(() => {
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
  });
}

describe('CommandRoom — persisted visual pane order', () => {
  it('projects cells and header ordinals from saved order without mutating canonical sessions', async () => {
    const canonicalSessions = [
      makeSession({ id: 's1', name: 'One' }),
      makeSession({ id: 's2', name: 'Two' }),
      makeSession({ id: 's3', name: 'Three' }),
    ];
    mockState.sessionsByWorkspace = { 'ws-1': canonicalSessions };
    silentKvGetMock.mockImplementation((key) => Promise.resolve(
      key === paneOrderKey()
        ? '{"version":1,"sessionIds":["s3","s1","s2"]}'
        : null,
    ));

    await renderCommandRoom();

    await waitFor(() => {
      expect(paneCellIds()).toEqual(['s3', 's1', 's2']);
    });
    expect(screen.getByRole('button', {
      name: 'Reorder Three, position 1 of 3',
    })).toBeTruthy();
    expect(screen.getByRole('button', {
      name: 'Reorder One, position 2 of 3',
    })).toBeTruthy();
    expect(screen.getByRole('button', {
      name: 'Reorder Two, position 3 of 3',
    })).toBeTruthy();
    expect(mockState.sessionsByWorkspace['ws-1']).toBe(canonicalSessions);
    expect(mockState.sessionsByWorkspace['ws-1']?.map((session) => session.id)).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('keeps reordering disabled until pane-order hydration finishes', async () => {
    const orderRead = deferred<string | null>();
    mockState.sessionsByWorkspace = {
      'ws-1': [
        makeSession({ id: 's1', name: 'One' }),
        makeSession({ id: 's2', name: 'Two' }),
      ],
    };
    silentKvGetMock.mockImplementation((key) => (
      key === paneOrderKey() ? orderRead.promise : Promise.resolve(null)
    ));

    await renderCommandRoom();

    const firstHandle = screen.getByRole('button', {
      name: 'Reorder One, position 1 of 2',
    });
    expect((firstHandle as HTMLButtonElement).disabled).toBe(true);

    orderRead.resolve('{"version":1,"sessionIds":["s1","s2"]}');
    await waitFor(() => {
      expect((firstHandle as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it.each([
    ['one pane', [makeSession({ id: 's1', name: 'One' })], null],
    [
      'a fullscreen pane',
      [
        makeSession({ id: 's1', name: 'One' }),
        makeSession({ id: 's2', name: 'Two' }),
      ],
      's1',
    ],
  ])('keeps reordering disabled with %s after hydration', async (_name, sessions, focusedPaneId) => {
    mockState.sessionsByWorkspace = { 'ws-1': sessions };
    mockState.focusedPaneId = focusedPaneId;

    await renderCommandRoom();

    await waitFor(() => {
      expect(silentKvGetMock).toHaveBeenCalledWith(paneOrderKey());
    });
    for (const handle of document.querySelectorAll<HTMLButtonElement>('[data-pane-reorder-handle]')) {
      expect(handle.disabled).toBe(true);
    }
  });

  it('keeps minimised panes eligible for reorder after hydration', async () => {
    mockState.sessionsByWorkspace = {
      'ws-1': [
        makeSession({ id: 's1', name: 'One', minimised: true }),
        makeSession({ id: 's2', name: 'Two' }),
      ],
    };

    await renderCommandRoom();

    await waitFor(() => {
      expect((screen.getByRole('button', {
        name: 'Reorder One, position 1 of 2',
      }) as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

describe('CommandRoom — pane-order lifecycle integration', () => {
  it('appends a passively added or split pane without rewriting saved order', async () => {
    const s1 = makeSession({ id: 's1', name: 'One' });
    const s2 = makeSession({ id: 's2', name: 'Two' });
    mockState.sessionsByWorkspace = { 'ws-1': [s1, s2] };
    silentKvGetMock.mockImplementation((key) => Promise.resolve(
      key === paneOrderKey()
        ? '{"version":1,"sessionIds":["s2","s1"]}'
        : null,
    ));
    const view = await renderCommandRoom();
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['s2', 's1']);
    });
    silentKvSetMock.mockClear();

    const splitParent = {
      ...s1,
      splitGroupId: 'split-1',
      splitDirection: 'vertical' as const,
      splitIndex: 0,
    };
    const splitChild = makeSession({
      id: 's3',
      name: 'Three',
      splitGroupId: 'split-1',
      splitDirection: 'vertical',
      splitIndex: 1,
    });
    mockState.sessionsByWorkspace = { 'ws-1': [splitParent, s2, splitChild] };
    view.rerenderCommandRoom();

    expect(paneCellIds()).toEqual(['s2', 's1', 's3']);
    expect(silentKvSetMock).not.toHaveBeenCalledWith(
      paneOrderKey(),
      expect.any(String),
    );
  });

  it('drops a closed pane without resurrection, order writes, or session mutation', async () => {
    const s1 = makeSession({ id: 's1', name: 'One' });
    const s2 = makeSession({ id: 's2', name: 'Two' });
    mockState.sessionsByWorkspace = { 'ws-1': [s1, s2] };
    silentKvGetMock.mockImplementation((key) => Promise.resolve(
      key === paneOrderKey()
        ? '{"version":1,"sessionIds":["s2","s1"]}'
        : null,
    ));
    const view = await renderCommandRoom();
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['s2', 's1']);
    });
    dispatchMock.mockClear();
    silentKvSetMock.mockClear();

    const s1Cell = screen.getAllByTestId('pane-cell').find(
      (cell) => cell.getAttribute('data-session-id') === 's1',
    );
    fireEvent.click(s1Cell!.querySelector('[aria-label="Close pane"]')!);

    expect(panesCloseMock).toHaveBeenCalledWith('s1');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's1' });
    mockState.sessionsByWorkspace = { 'ws-1': [s2] };
    view.rerenderCommandRoom();

    expect(paneCellIds()).toEqual(['s2']);
    expect(mockState.sessionsByWorkspace['ws-1']?.[0]).toBe(s2);
    expect(silentKvSetMock).not.toHaveBeenCalledWith(
      paneOrderKey(),
      expect.any(String),
    );
  });

  it('reads and writes presentation order only under each active workspace key', async () => {
    mockPaneRects(['a1', 'a2', 'b1', 'b2']);
    const workspaceA = makeWorkspace('ws-a');
    const workspaceB = makeWorkspace('ws-b');
    mockState.activeWorkspace = workspaceA;
    mockState.activeWorkspaceId = workspaceA.id;
    mockState.activeSessionId = 'a1';
    mockState.sessionsByWorkspace = {
      'ws-a': [
        makeSession({ id: 'a1', workspaceId: 'ws-a', name: 'A One' }),
        makeSession({ id: 'a2', workspaceId: 'ws-a', name: 'A Two' }),
      ],
      'ws-b': [
        makeSession({ id: 'b1', workspaceId: 'ws-b', name: 'B One' }),
        makeSession({ id: 'b2', workspaceId: 'ws-b', name: 'B Two' }),
      ],
    };
    mockState.swarmsByWorkspace = { 'ws-a': [], 'ws-b': [] };
    silentKvGetMock.mockImplementation((key) => Promise.resolve(
      key === paneOrderKey('ws-a')
        ? '{"version":1,"sessionIds":["a1","a2"]}'
        : key === paneOrderKey('ws-b')
          ? '{"version":1,"sessionIds":["b1","b2"]}'
          : null,
    ));
    const view = await renderCommandRoom();
    await waitFor(() => {
      expect((screen.getByRole('button', {
        name: 'Reorder A One, position 1 of 2',
      }) as HTMLButtonElement).disabled).toBe(false);
    });

    await keyboardSwap('A One', 1, 2, 'ArrowRight');
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['a2', 'a1']);
    });
    expect(silentKvSetMock).toHaveBeenCalledWith(
      paneOrderKey('ws-a'),
      '{"version":1,"sessionIds":["a2","a1"]}',
    );

    mockState.activeWorkspace = workspaceB;
    mockState.activeWorkspaceId = workspaceB.id;
    mockState.activeSessionId = 'b1';
    view.rerenderCommandRoom();
    await waitFor(() => {
      expect((screen.getByRole('button', {
        name: 'Reorder B One, position 1 of 2',
      }) as HTMLButtonElement).disabled).toBe(false);
    });
    await keyboardSwap('B One', 1, 2, 'ArrowRight');
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['b2', 'b1']);
    });

    expect(silentKvGetMock).toHaveBeenCalledWith(paneOrderKey('ws-a'));
    expect(silentKvGetMock).toHaveBeenCalledWith(paneOrderKey('ws-b'));
    expect(silentKvSetMock).toHaveBeenCalledWith(
      paneOrderKey('ws-b'),
      '{"version":1,"sessionIds":["b2","b1"]}',
    );
    expect(silentKvSetMock.mock.calls.filter(([key]) => (
      key.includes('commandRoom.paneOrder')
    )).map(([key]) => key)).toEqual([
      paneOrderKey('ws-a'),
      paneOrderKey('ws-b'),
    ]);
  });

  it('keeps an optimistic visual swap when its best-effort order write fails', async () => {
    mockPaneRects(['s1', 's2']);
    mockState.activeSessionId = 's1';
    mockState.sessionsByWorkspace = {
      'ws-1': [
        makeSession({ id: 's1', name: 'One' }),
        makeSession({ id: 's2', name: 'Two' }),
      ],
    };
    silentKvSetMock.mockRejectedValue(new Error('disk full'));
    await renderCommandRoom();
    await waitFor(() => {
      expect((screen.getByRole('button', {
        name: 'Reorder One, position 1 of 2',
      }) as HTMLButtonElement).disabled).toBe(false);
    });

    await keyboardSwap('One', 1, 2, 'ArrowRight');

    await waitFor(() => {
      expect(paneCellIds()).toEqual(['s2', 's1']);
    });
    expect(silentKvSetMock).toHaveBeenCalledWith(
      paneOrderKey(),
      '{"version":1,"sessionIds":["s2","s1"]}',
    );
  });

  it('preserves active pane identity and attention dispatches across a visual swap', async () => {
    mockPaneRects(['s1', 's2']);
    const s1 = makeSession({ id: 's1', name: 'One' });
    const s2 = makeSession({ id: 's2', name: 'Two' });
    mockState.activeSessionId = 's1';
    mockState.sessionsByWorkspace = { 'ws-1': [s1, s2] };
    await renderCommandRoom();
    await waitFor(() => {
      expect((screen.getByRole('button', {
        name: 'Reorder One, position 1 of 2',
      }) as HTMLButtonElement).disabled).toBe(false);
    });
    const terminalS1 = screen.getByTestId('terminal-s1');
    dispatchMock.mockClear();

    await keyboardSwap('One', 1, 2, 'ArrowRight');

    const activeCell = screen.getAllByTestId('pane-cell').find(
      (cell) => cell.getAttribute('data-active') === 'true',
    );
    expect(activeCell?.getAttribute('data-session-id')).toBe('s1');
    expect(screen.getByTestId('terminal-s1')).toBe(terminalS1);
    expect(mockState.sessionsByWorkspace['ws-1']).toEqual([s1, s2]);
    expect(dispatchMock).not.toHaveBeenCalled();

    const s2Cell = screen.getAllByTestId('pane-cell').find(
      (cell) => cell.getAttribute('data-session-id') === 's2',
    );
    fireEvent.mouseDown(s2Cell!);
    expect(dispatchMock.mock.calls.map(([action]) => action)).toEqual([
      { type: 'CLEAR_SESSION_ATTENTION', sessionId: 's2' },
      { type: 'SET_ACTIVE_SESSION', id: 's2' },
    ]);
  });

  it('replaces a crashed session in its visual slot before activation and removal', async () => {
    const crashed = makeSession({
      id: 'crashed',
      name: 'Crashed',
      status: 'error',
      exitCode: 1,
      providerId: 'codex',
    });
    mockState.sessionsByWorkspace = {
      'ws-1': [
        makeSession({ id: 's1', name: 'One' }),
        crashed,
        makeSession({ id: 's3', name: 'Three' }),
      ],
    };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    mockState.activeSwarmId = 'swarm-1';
    silentKvGetMock.mockImplementation((key) => Promise.resolve(
      key === paneOrderKey()
        ? '{"version":1,"sessionIds":["s1","crashed","s3"]}'
        : null,
    ));
    const replacement = makeSession({
      id: 'replacement',
      name: 'Replacement',
      providerId: 'codex',
    });
    addAgentMock.mockResolvedValue({
      sessionId: replacement.id,
      paneIndex: 1,
      agentKey: 'codex-2',
      session: replacement,
      swarm: makeSwarm('running'),
    });
    const sequence: string[] = [];
    dispatchMock.mockImplementation((action: { type: string }) => {
      if (['ADD_SESSIONS', 'SET_ACTIVE_SESSION', 'REMOVE_SESSION'].includes(action.type)) {
        sequence.push(action.type);
      }
    });
    silentKvSetMock.mockImplementation(async (key, value) => {
      if (key === paneOrderKey()) sequence.push(`PERSIST:${value}`);
    });
    panesCloseMock.mockImplementation(async (id: string) => {
      sequence.push(`CLOSE:${id}`);
    });
    await renderCommandRoom();
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['s1', 'crashed', 's3']);
    });
    sequence.length = 0;
    silentKvSetMock.mockClear();

    fireEvent.click(screen.getByTestId('pane-relaunch-button'));

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 'crashed' });
    });
    expect(sequence).toEqual([
      'ADD_SESSIONS',
      'PERSIST:{"version":1,"sessionIds":["s1","replacement","s3"]}',
      'SET_ACTIVE_SESSION',
      'CLOSE:crashed',
      'REMOVE_SESSION',
    ]);
    expect(silentKvSetMock).toHaveBeenCalledTimes(1);
  });

  it('finishes a deferred relaunch in its starting workspace after switching away', async () => {
    const workspaceA = makeWorkspace('ws-a');
    const workspaceB = makeWorkspace('ws-b');
    const a1 = makeSession({ id: 'a1', workspaceId: 'ws-a', name: 'A One' });
    const crashed = makeSession({
      id: 'crashed',
      workspaceId: 'ws-a',
      name: 'A Crashed',
      status: 'error',
      exitCode: 1,
      providerId: 'codex',
    });
    const a3 = makeSession({ id: 'a3', workspaceId: 'ws-a', name: 'A Three' });
    const b1 = makeSession({ id: 'b1', workspaceId: 'ws-b', name: 'B One' });
    const b2 = makeSession({ id: 'b2', workspaceId: 'ws-b', name: 'B Two' });
    const canonicalB = [b1, b2];
    mockState.activeWorkspace = workspaceA;
    mockState.activeWorkspaceId = workspaceA.id;
    mockState.activeSessionId = crashed.id;
    mockState.activeSwarmId = 'swarm-1';
    mockState.sessionsByWorkspace = {
      'ws-a': [a1, crashed, a3],
      'ws-b': canonicalB,
    };
    mockState.swarmsByWorkspace = {
      'ws-a': [makeSwarm('running')],
      'ws-b': [],
    };
    const orderRecords = new Map<string, string>([
      [paneOrderKey('ws-a'), '{"version":1,"sessionIds":["a3","crashed","a1"]}'],
      [paneOrderKey('ws-b'), '{"version":1,"sessionIds":["b2","b1"]}'],
    ]);
    silentKvGetMock.mockImplementation((key) => Promise.resolve(orderRecords.get(key) ?? null));
    silentKvSetMock.mockImplementation(async (key, value) => {
      orderRecords.set(key, value);
    });
    const addAgentResult = deferred<{
      sessionId: string;
      paneIndex: number;
      agentKey: string;
      session: AgentSession;
      swarm: Swarm;
    }>();
    addAgentMock.mockReturnValue(addAgentResult.promise);
    const replacement = makeSession({
      id: 'replacement',
      workspaceId: 'ws-a',
      name: 'A Replacement',
      providerId: 'codex',
    });
    const view = await renderCommandRoom();
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['a3', 'crashed', 'a1']);
    });

    fireEvent.click(screen.getByTestId('pane-relaunch-button'));
    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledTimes(1);
    });

    mockState.activeWorkspace = workspaceB;
    mockState.activeWorkspaceId = workspaceB.id;
    mockState.activeSessionId = b1.id;
    mockState.activeSwarmId = null;
    view.rerenderCommandRoom();
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['b2', 'b1']);
    });
    silentKvSetMock.mockClear();

    addAgentResult.resolve({
      sessionId: replacement.id,
      paneIndex: 1,
      agentKey: 'codex-2',
      session: replacement,
      swarm: makeSwarm('running'),
    });
    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: crashed.id });
    });

    expect(paneCellIds()).toEqual(['b2', 'b1']);
    expect(mockState.sessionsByWorkspace['ws-b']).toBe(canonicalB);
    expect(silentKvSetMock).not.toHaveBeenCalledWith(
      paneOrderKey('ws-b'),
      expect.any(String),
    );
    expect(silentKvSetMock.mock.calls.filter(([key]) => key === paneOrderKey('ws-a'))).toEqual([
      [paneOrderKey('ws-a'), '{"version":1,"sessionIds":["a3","replacement","a1"]}'],
    ]);

    const canonicalA = [a1, replacement, a3];
    mockState.sessionsByWorkspace = {
      'ws-a': canonicalA,
      'ws-b': canonicalB,
    };
    mockState.activeWorkspace = workspaceA;
    mockState.activeWorkspaceId = workspaceA.id;
    mockState.activeSessionId = replacement.id;
    mockState.activeSwarmId = 'swarm-1';
    view.rerenderCommandRoom();
    await waitFor(() => {
      expect(paneCellIds()).toEqual(['a3', 'replacement', 'a1']);
    });
    expect(mockState.sessionsByWorkspace['ws-a']).toBe(canonicalA);
    expect(mockState.sessionsByWorkspace['ws-b']).toBe(canonicalB);
    expect(silentKvSetMock.mock.calls.filter(([key]) => (
      key.includes('commandRoom.paneOrder')
    ))).toHaveLength(1);
  });
});

describe('CommandRoom — v1.4.3 #05 EmptyState defensive UX', () => {
  it('shows both "Add first pane" + "Go to Workspaces" when swarm running + providers loaded', async () => {
    // Seed the active workspace + running swarm, leave sessions empty.
    mockState.sessionsByWorkspace = {};
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    await renderCommandRoom();

    // The providers effect runs `listProviders.list()` on mount; the empty
    // state re-renders after providers resolve.
    await waitFor(() => {
      expect(screen.getByText('Add first pane')).toBeTruthy();
    });
    expect(screen.getByText('Go to Workspaces')).toBeTruthy();
  });

  it('shows only "Go to Workspaces" when the active swarm is paused', async () => {
    mockState.sessionsByWorkspace = {};
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('paused')] };
    await renderCommandRoom();

    // No "Add first pane" when canAddPane=false. The empty state still
    // renders "Go to Workspaces" as the only affordance.
    await waitFor(() => {
      expect(screen.getByText('Go to Workspaces')).toBeTruthy();
    });
    expect(screen.queryByText('Add first pane')).toBeNull();
  });

  it('shows only "Go to Workspaces" when the providers list is empty', async () => {
    mockState.sessionsByWorkspace = {};
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    listProvidersMock.mockResolvedValue([]);
    await renderCommandRoom();

    await waitFor(() => {
      expect(screen.getByText('Go to Workspaces')).toBeTruthy();
    });
    // The "Add first pane" branch is gated on providers.length > 0.
    expect(screen.queryByText('Add first pane')).toBeNull();
  });

  it('does NOT render the EmptyState when sessions.length > 0; the top-bar +Pane button is visible', async () => {
    mockState.sessionsByWorkspace = { 'ws-1': [makeSession()] };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    await renderCommandRoom();

    // No empty state title.
    expect(screen.queryByText('No agents launched yet')).toBeNull();
    // Top-bar +Pane button renders (the disabled-state regression check —
    // a non-empty workspace must show the live button, never the triangle).
    await waitFor(() => {
      expect(
        screen.queryAllByRole('button').filter((b) => b.textContent?.includes('Pane')).length,
      ).toBeGreaterThan(0);
    });
  });

  it('dispatches addAgent with the first provider when "Add first pane" is clicked', async () => {
    mockState.sessionsByWorkspace = {};
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    addAgentMock.mockResolvedValue({
      sessionId: 's-new',
      paneIndex: 0,
      agentKey: 'builder-1',
      session: makeSession({ id: 's-new' }),
      swarm: makeSwarm('running'),
    });
    await renderCommandRoom();
    await waitFor(() => screen.getByText('Add first pane'));

    fireEvent.click(screen.getByText('Add first pane'));

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledTimes(1);
    });
    // providers[0] is "claude" per the seed above.
    expect(addAgentMock).toHaveBeenCalledWith({
      swarmId: 'swarm-1',
      providerId: 'claude',
    });
  });
});

// ---- v1.13.2 — empty-state UPSERT ordering + relaunch -----------------------
describe('CommandRoom — v1.13.2 hardened pane-add', () => {
  it('does NOT UPSERT_SWARM when addAgent rejects (no orphaned empty swarm)', async () => {
    // Zero-swarms case: create resolves, addAgent rejects. The new swarm must
    // never be written into state, so no agent-less orphan survives.
    mockState.sessionsByWorkspace = {};
    mockState.swarmsByWorkspace = { 'ws-1': [] };
    mockState.activeSwarmId = null;
    const newSwarm = makeSwarm('running');
    listSwarmsMock.mockResolvedValue([]);
    createSwarmMock.mockResolvedValue(newSwarm);
    addAgentMock.mockRejectedValue(new Error('addAgent boom'));

    await renderCommandRoom();
    await waitFor(() => screen.getByText('Add first pane'));
    fireEvent.click(screen.getByText('Add first pane'));

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledTimes(1);
    });
    // No UPSERT_SWARM dispatch occurred — the orphan is never created.
    const upserts = dispatchMock.mock.calls
      .map(([a]) => a)
      .filter((a) => (a as { type: string }).type === 'UPSERT_SWARM');
    expect(upserts).toHaveLength(0);
  });

  it('relaunches a crashed pane: addAgent same provider, then REMOVE_SESSION', async () => {
    const crashed = makeSession({ id: 's1', status: 'error', exitCode: 1, providerId: 'codex' });
    mockState.sessionsByWorkspace = { 'ws-1': [crashed] };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    mockState.activeSwarmId = 'swarm-1';
    addAgentMock.mockResolvedValue({
      sessionId: 's-new',
      paneIndex: 1,
      agentKey: 'codex-1',
      session: makeSession({ id: 's-new', providerId: 'codex' }),
      swarm: makeSwarm('running'),
    });

    await renderCommandRoom();
    await waitFor(() => screen.getByTestId('terminal-s1'));

    fireEvent.click(screen.getByTestId('pane-relaunch-button'));

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledWith({ swarmId: 'swarm-1', providerId: 'codex' });
    });
    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledWith({ type: 'ADD_SESSIONS', sessions: expect.any(Array) });
    });
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's1' });
    // session-persistence fix (2026-07-18) — the crashed ROW must be closed in
    // the DB, not just removed from renderer state: an open (closed_at NULL)
    // row lingers as a stale sibling in its slot and boot auto-resume used to
    // respawn its OLD conversation.
    expect(panesCloseMock).toHaveBeenCalledWith('s1');
  });
});

describe('CommandRoom — uniform fill-grid', () => {
  it('renders every session as its own grid cell, even when they share a split_group_id', async () => {
    // The split-group model is retired: in the fill-grid, two sessions sharing a
    // split_group_id are just two independent cells (no nested sub-grid).
    mockState.sessionsByWorkspace = {
      'ws-1': [
        makeSession({ id: 'half-a', splitGroupId: 'g-1', splitDirection: 'vertical', splitIndex: 0 }),
        makeSession({ id: 'half-b', splitGroupId: 'g-1', splitDirection: 'vertical', splitIndex: 1 }),
      ],
    };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    await renderCommandRoom();

    await waitFor(() => screen.getByTestId('terminal-half-a'));
    expect(screen.getByTestId('terminal-half-b')).toBeTruthy();
    // Two distinct grid cells (one per session) — no special grouping.
    expect(screen.getAllByTestId('pane-cell')).toHaveLength(2);
  });

  it('renders standalone sessions as their own cells', async () => {
    mockState.sessionsByWorkspace = {
      'ws-1': [makeSession({ id: 's1' }), makeSession({ id: 's2' })],
    };
    await renderCommandRoom();

    await waitFor(() => screen.getByTestId('terminal-s1'));
    expect(screen.getByTestId('terminal-s2')).toBeTruthy();
    expect(screen.getAllByTestId('pane-cell')).toHaveLength(2);
  });
});

// ---- v1.4.8 drag-drop tests -----------------------------------------------
//
// jsdom does not implement a spec-compliant DataTransfer constructor, so we
// build a minimal stub that satisfies the drop-handler's read path.

function makeDataTransfer(
  overrides: Partial<{
    types: string[];
    sigmaPayload: string | null;
    files: File[];
  }> = {},
): DataTransfer {
  const { types = [], sigmaPayload = null, files = [] } = overrides;
  const dataMap = new Map<string, string>();
  if (sigmaPayload !== null) {
    dataMap.set('application/sigmalink-file', sigmaPayload);
  }
  return {
    types,
    files: files as unknown as FileList,
    dropEffect: 'none',
    effectAllowed: 'none',
    getData: (key: string) => dataMap.get(key) ?? '',
    setData: (key: string, value: string) => { dataMap.set(key, value); },
    clearData: vi.fn(),
    items: {} as DataTransferItemList,
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

describe('CommandRoom — v1.4.8 drag-drop file @-mention', () => {
  beforeEach(() => {
    // Stub window.sigma so PaneShell's Finder-drop path doesn't throw.
    Object.defineProperty(window, 'sigma', {
      configurable: true,
      value: {
        invoke: vi.fn(),
        eventOn: vi.fn(() => () => undefined),
        eventSend: vi.fn(),
        getPathForFile: vi.fn((file: File) => `/abs/${file.name}`),
        platform: 'darwin' as NodeJS.Platform,
      },
    });
    ptyWriteMock.mockResolvedValue(undefined);
  });

  /** Find the pane body div that carries onDragOver/onDrop. */
  function findPaneBody(): Element | null {
    // v1.5.1-A: PaneShell sets data-testid="pane-body" — use stable testid
    // instead of brittle Tailwind class-token matching.
    return document.querySelector('[data-testid="pane-body"]');
  }

  /**
   * Fire a synthetic drop event with a custom dataTransfer stub.
   * jsdom's DragEvent constructor does not honour the `dataTransfer` init
   * dict, so we dispatch a plain Event and Object.assign the dataTransfer
   * onto it before dispatch.
   */
  function fireDrop(target: Element, dt: DataTransfer): void {
    const dropEv = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
    target.dispatchEvent(dropEv);
  }

  function fireDragOver(target: Element, dt: DataTransfer): void {
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    target.dispatchEvent(ev);
  }

  it('calls rpc.pty.write with "@<relativePath> " on drop of sigmalink-file payload', async () => {
    mockState.sessionsByWorkspace = { 'ws-1': [makeSession({ id: 's1', status: 'running' })] };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    await renderCommandRoom();
    await waitFor(() => screen.getByTestId('terminal-s1'));

    const payload = JSON.stringify({
      absolutePath: '/tmp/ws-1/src/App.tsx',
      relativePath: 'src/App.tsx',
      workspaceId: 'ws-1',
    });
    const dt = makeDataTransfer({
      types: ['application/sigmalink-file'],
      sigmaPayload: payload,
    });

    const paneDiv = findPaneBody();
    expect(paneDiv).not.toBeNull();

    fireDragOver(paneDiv!, dt);
    fireDrop(paneDiv!, dt);

    await waitFor(() => {
      expect(ptyWriteMock).toHaveBeenCalledWith('s1', '@src/App.tsx ');
    });
  });

  it('does NOT call rpc.pty.write when session status is "exited"', async () => {
    mockState.sessionsByWorkspace = { 'ws-1': [makeSession({ id: 's1', status: 'exited' })] };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    await renderCommandRoom();
    await waitFor(() => screen.getByTestId('terminal-s1'));

    const payload = JSON.stringify({
      absolutePath: '/tmp/ws-1/foo.ts',
      relativePath: 'foo.ts',
      workspaceId: 'ws-1',
    });
    const dt = makeDataTransfer({
      types: ['application/sigmalink-file'],
      sigmaPayload: payload,
    });

    const paneDiv = findPaneBody();
    fireDragOver(paneDiv!, dt);
    fireDrop(paneDiv!, dt);

    // Give async operations time to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });
});

describe('CommandRoom — Esc exits fullscreen only when the terminal did not consume it', () => {
  async function renderFocused() {
    mockState.sessionsByWorkspace = { 'ws-1': [makeSession({ id: 's1' })] };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    mockState.activeSessionId = 's1';
    mockState.focusedPaneId = 's1';
    await renderCommandRoom();
    await waitFor(() => screen.getByTestId('terminal-s1'));
  }

  it('plain Escape (chrome-focused) dispatches UNFOCUS_PANE', async () => {
    await renderFocused();
    dispatchMock.mockClear();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'UNFOCUS_PANE' });
  });

  it('terminal-consumed Escape (defaultPrevented) does NOT unfocus the pane', async () => {
    // DomTerminalView / xterm preventDefault() every key they encode into PTY
    // bytes — Esc typed to interrupt an agent arrives at window already
    // consumed. It must interrupt the agent, not also kick the pane out of
    // fullscreen.
    await renderFocused();
    dispatchMock.mockClear();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ev.preventDefault();
    document.body.dispatchEvent(ev);
    expect(dispatchMock).not.toHaveBeenCalledWith({ type: 'UNFOCUS_PANE' });
  });
});
