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

const addAgentMock = vi.fn();
const listProvidersMock = vi.fn();
const listSwarmsMock = vi.fn();
const ptyKillMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    providers: {
      list: (...args: unknown[]) => listProvidersMock(...args),
    },
    swarms: {
      addAgent: (...args: unknown[]) => addAgentMock(...args),
      list: (...args: unknown[]) => listSwarmsMock(...args),
      splitPane: vi.fn(),
      minimisePane: vi.fn(),
    },
    pty: {
      kill: (...args: unknown[]) => ptyKillMock(...args),
    },
    app: {
      revealInFolder: vi.fn(),
      openShell: vi.fn(),
    },
  },
  rpcSilent: { providers: { list: vi.fn(() => Promise.resolve([])) } },
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
  listProvidersMock.mockReset();
  listSwarmsMock.mockReset();
  ptyKillMock.mockReset();
  listProvidersMock.mockResolvedValue([
    { id: 'claude', name: 'Claude' },
    { id: 'codex', name: 'Codex' },
  ]);
  listSwarmsMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

function makeWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Workspace 1',
    rootPath: '/tmp/ws-1',
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
  return render(<CommandRoom />);
}

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

describe('CommandRoom — v1.4.3 #06 cell grouping', () => {
  it('renders ONE cell containing two SessionTerminals when both sessions share a split_group_id', async () => {
    mockState.sessionsByWorkspace = {
      'ws-1': [
        makeSession({
          id: 'half-a',
          splitGroupId: 'g-1',
          splitDirection: 'vertical',
          splitIndex: 0,
        }),
        makeSession({
          id: 'half-b',
          splitGroupId: 'g-1',
          splitDirection: 'vertical',
          splitIndex: 1,
        }),
      ],
    };
    mockState.swarmsByWorkspace = { 'ws-1': [makeSwarm('running')] };
    await renderCommandRoom();

    // Both terminals mount inside the split cell.
    await waitFor(() => screen.getByTestId('terminal-half-a'));
    expect(screen.getByTestId('terminal-half-b')).toBeTruthy();

    // A sub-divider with role="separator" sits between the two halves.
    const sep = screen.getAllByRole('separator');
    expect(sep.length).toBeGreaterThanOrEqual(1);
  });

  it('renders standalone sessions as their own cells when no split_group_id is set', async () => {
    mockState.sessionsByWorkspace = {
      'ws-1': [makeSession({ id: 's1' }), makeSession({ id: 's2' })],
    };
    await renderCommandRoom();

    await waitFor(() => screen.getByTestId('terminal-s1'));
    expect(screen.getByTestId('terminal-s2')).toBeTruthy();
  });
});
