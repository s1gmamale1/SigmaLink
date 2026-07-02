// @vitest-environment jsdom
//
// 2026-06-10 audit, finding 7 — sibling-drift guard. Launcher.chooseExisting
// and Sidebar.openPersistedWorkspace are twin workspace-open hydration
// read-paths. The Sidebar (and use-session-restore) hydrate swarms
// INDEPENDENTLY of sessions; the Launcher used to nest swarm hydration inside
// `if (sessions.length > 0)`, so a swarm-but-no-panes workspace silently
// skipped UPSERT_SWARM (masked by the canonical use-live-events loader).
// This locks the aligned behavior. Harness mirrors
// Launcher.sessions.integration.test.tsx.

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workspace } from '@/shared/types';

// The drift case: a RUNNING swarm but ZERO panes.
const runningSwarm = {
  id: 'swarm-1',
  workspaceId: 'ws-drift',
  status: 'running',
  name: 'drift swarm',
  startedAt: 0,
};

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: async () => null, set: async () => undefined },
    providers: { probeAll: async () => [] },
    workspaces: {
      launch: async () => ({ sessions: [] }),
      pickFolder: async () => null,
      open: async () => makeWorkspace(),
      list: async () => [makeWorkspace()],
    },
    panes: { listForWorkspace: async () => [] },
    swarms: { list: async () => [runningSwarm] },
    design: { createCanvas: async () => ({}) },
    browser: { getState: async () => ({ tabs: [] }) },
  },
  rpcSilent: {
    panes: {
      listSessions: async () => [],
      lastResumePlan: async () => [],
    },
    kv: { get: async () => null },
  },
}));

const dispatchMock = vi.fn();
vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeWorkspace: makeWorkspace(), workspaces: [makeWorkspace()] }),
  ),
}));

// StartStep stub fires onChooseRecent immediately → chooseExisting runs.
vi.mock('./StartStep', () => ({
  StartStep: ({
    onChooseRecent,
    recents,
  }: {
    onChooseRecent: (ws: Workspace) => void;
    recents: Workspace[];
  }) => {
    const ws = recents[0];
    if (ws) void Promise.resolve().then(() => onChooseRecent(ws));
    return <div data-testid="start-step-stub" />;
  },
}));
// minimal-chrome — stub the intent landing to a single mode row so the test can
// advance into the wizard (which mounts StartStep → chooseExisting).
vi.mock('./LauncherLanding', () => ({
  LauncherLanding: ({ onPick }: { onPick: (m: string) => void }) => (
    <button data-testid="intent-card-space" onClick={() => onPick('space')}>space</button>
  ),
}));
vi.mock('./Stepper', () => ({ Stepper: () => <div data-testid="stepper" /> }));
vi.mock('./LayoutStep', () => ({ LayoutStep: () => <div data-testid="layout-step" /> }));
vi.mock('./AgentsStep', () => ({ AgentsStep: () => <div data-testid="agents-step" /> }));
vi.mock('./SessionStep', () => ({
  SessionStep: () => <div data-testid="session-step" />,
  fetchLastResumePlan: async () => [],
}));
vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: () => <input type="checkbox" />,
}));
vi.mock('@/renderer/components/ErrorBanner', () => ({
  ErrorBanner: ({ message }: { message: string }) => <div data-testid="error-banner">{message}</div>,
}));

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-drift',
    name: 'Drift Test WS',
    rootPath: '/tmp/drift',
    repoRoot: null,
    repoMode: 'plain',
    createdAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe('Launcher.chooseExisting — swarm-but-no-panes hydration (twin: Sidebar.openPersistedWorkspace)', () => {
  it('dispatches UPSERT_SWARM + SET_ACTIVE_SWARM even when the workspace has zero panes', async () => {
    const { WorkspaceLauncher } = await import('./Launcher');
    await act(async () => {
      render(<WorkspaceLauncher />);
      await Promise.resolve();
    });
    // minimal-chrome — leave the intent landing so StartStep mounts and fires
    // onChooseRecent → chooseExisting.
    await act(async () => {
      fireEvent.click(screen.getByTestId('intent-card-space'));
      // Pump microtasks: StartStep → onChooseRecent → chooseExisting →
      // Promise.all(listForWorkspace, swarms.list) resolves.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledWith({ type: 'UPSERT_SWARM', swarm: runningSwarm });
    });
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'SET_ACTIVE_SWARM', id: 'swarm-1' });
    // Alignment with the Sidebar twin: an empty pane list must NOT dispatch
    // ADD_SESSIONS.
    expect(dispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ADD_SESSIONS' }),
    );
  });
});
