// @vitest-environment jsdom
//
// v1.3.1 — Launcher payload-construction tests.
//
// Focused unit tests for `buildPaneResumePlanArray` — the helper that
// translates the SessionStep's `paneResumePlan` record into the top-level
// `LaunchPlan.paneResumePlan` array shape the backend expects.
//
// Bug B regression guard: v1.3.0 placed `sessionId` inside each `panes[i]`
// object instead of building the top-level array. `executeLaunchPlan` reads
// `plan.paneResumePlan?.find((r) => r.paneIndex === pane.paneIndex)` — when
// the array was missing, every pane spawned fresh. These tests pin the
// contract so a future refactor can't silently revert it.
//
// SF-8 B2 — Yolo/Bypass toggle tests:
//   B2-1: yolo-toggle renders with danger warning text
//   B2-2: yolo-toggle defaults ON when per-workspace kv returns '1'
//   B2-3: yolo-toggle defaults OFF when per-workspace kv returns null
//   B2-4: launch payload panes all have autoApprove:true when toggle is ON
//   B2-5: launch payload panes have autoApprove:false when toggle is OFF
//   B2-6: toggling ON persists kv.set with '1'
//   B2-7: toggling OFF persists kv.set with '0'

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { buildPaneResumePlanArray } from './Launcher';

// ---------------------------------------------------------------------------
// Mocks for WorkspaceLauncher integration tests
// ---------------------------------------------------------------------------

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>(async () => null);
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>(async () => undefined);
const probeAllMock = vi.fn(async () => []);
const workspacesLaunchMock = vi.fn<(plan: unknown) => Promise<{ sessions: unknown[] }>>(
  async () => ({ sessions: [] }),
);
const workspacesPickFolderMock = vi.fn(async () => null);
const workspacesOpenMock = vi.fn<(path: string) => Promise<Workspace>>(async () => makeWorkspace());
const workspacesListMock = vi.fn(async () => []);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: (key: string) => kvGetMock(key), set: (key: string, value: string) => kvSetMock(key, value) },
    providers: { probeAll: () => probeAllMock() },
    workspaces: {
      launch: (plan: unknown) => workspacesLaunchMock(plan),
      pickFolder: () => workspacesPickFolderMock(),
      open: (path: string) => workspacesOpenMock(path),
      list: () => workspacesListMock(),
    },
    panes: { listForWorkspace: async () => [] },
    swarms: { list: async () => [] },
    design: { createCanvas: async () => ({}) },
    browser: { getState: async () => ({ tabs: [] }) },
  },
  // N1 — IntentCards reads `rpcSilent.kv.get('canvas.gaSign')` on mount. Provide
  // a silent stub so the real IntentCards (rendered in the Start step) is inert.
  rpcSilent: { kv: { get: async () => null } },
}));

const dispatchMock = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchMock,
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) => {
    // Return null for activeWorkspace and [] for workspaces by default;
    // overridden per-test by mockImplementation.
    return selector({ activeWorkspace: null, workspaces: [] });
  }),
}));

// Stub sub-step components to avoid full render complexity.
// N1 — IntentCards replaces the old PickerCards row; the stub exposes one
// button per mode so routing tests can switch modes.
vi.mock('./IntentCards', () => ({
  IntentCards: ({ onChange }: { onChange: (m: string) => void }) => (
    <div data-testid="intent-cards">
      <button data-testid="pick-space" onClick={() => onChange('space')}>space</button>
      <button data-testid="pick-single" onClick={() => onChange('single')}>single</button>
      <button data-testid="pick-swarm" onClick={() => onChange('swarm')}>swarm</button>
      <button data-testid="pick-canvas" onClick={() => onChange('canvas')}>canvas</button>
    </div>
  ),
}));
vi.mock('./Stepper', () => ({
  // N1 — the mode-aware Stepper now receives a `steps` array; the stub renders
  // the visible step ids so routing tests can assert which steps show.
  Stepper: ({ steps, onJump }: { steps: string[]; onJump: (s: string) => void }) => (
    <div data-testid="stepper" data-steps={steps.join(',')}>
      <button data-testid="jump-agents" onClick={() => onJump('agents')}>agents</button>
    </div>
  ),
}));
vi.mock('./StartStep', () => ({
  StartStep: () => <div data-testid="start-step" />,
}));
vi.mock('./LayoutStep', () => ({
  LayoutStep: () => <div data-testid="layout-step" />,
}));
vi.mock('./AgentsStep', async () => {
  const { useEffect } = await import('react');
  return {
    // The mock calls onSkipChange(true) on mount so the launch button is
    // enabled without having to fill the agents matrix.
    AgentsStep: ({ onSkipChange }: { onSkipChange: (v: boolean) => void }) => {
      useEffect(() => { onSkipChange(true); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
      return <div data-testid="agents-step" />;
    },
  };
});
vi.mock('./SessionStep', () => ({
  SessionStep: () => <div data-testid="session-step" />,
  fetchLastResumePlan: async () => [],
}));

// Stub UI primitives that use Radix (may not render in jsdom).
vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>,
}));
vi.mock('@/renderer/components/ErrorBanner', () => ({
  ErrorBanner: ({ message }: { message: string }) => <div data-testid="error-banner">{message}</div>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { Workspace } from '@/shared/types';

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-42',
    name: 'Test WS',
    rootPath: '/tmp/test-ws',
    repoRoot: null,
    repoMode: 'plain',
    createdAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  };
}

async function renderLauncher(activeWorkspace: Workspace | null = null) {
  const { useAppStateSelector } = await import('@/renderer/app/state');
  const mockedSelector = vi.mocked(useAppStateSelector);
  mockedSelector.mockImplementation((selector) =>
    (selector as (s: unknown) => unknown)({
      activeWorkspace,
      workspaces: activeWorkspace ? [activeWorkspace] : [],
    }),
  );
  const { WorkspaceLauncher } = await import('./Launcher');
  return render(<WorkspaceLauncher />);
}

beforeEach(() => {
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
  workspacesLaunchMock.mockReset().mockResolvedValue({ sessions: [] });
  dispatchMock.mockReset();
  // Use real timers for async kv reads in tests; individual tests that need
  // fake timers will call vi.useFakeTimers() themselves.
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// SF-8 B2 — Yolo/Bypass toggle integration tests
// ---------------------------------------------------------------------------

describe('WorkspaceLauncher — Yolo/Bypass toggle (SF-8 B2)', () => {
  it('B2-1: yolo-toggle renders with danger warning text', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    const toggle = screen.getByTestId('yolo-toggle');
    expect(toggle).toBeTruthy();
    // The warning text should be present somewhere near the toggle.
    expect(screen.getByText(/yolo.*bypass mode/i) || screen.getByText(/bypass mode/i)).toBeTruthy();
    // Sublabel with danger wording.
    expect(screen.getByText(/trusted workspaces/i)).toBeTruthy();
  });

  it('B2-2: yolo-toggle defaults ON when kv returns "1" for workspace', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'pane.autoApprove.default.ws-42') return '1';
      return null;
    });
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    // Wait for the async kv read to complete.
    await waitFor(() => {
      const toggle = screen.getByTestId('yolo-toggle');
      // Radix Switch sets data-state="checked" when on.
      expect(toggle.getAttribute('data-state') === 'checked' ||
             toggle.getAttribute('aria-checked') === 'true').toBe(true);
    });
  });

  it('B2-3: yolo-toggle defaults OFF when kv returns null', async () => {
    kvGetMock.mockResolvedValue(null);
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await waitFor(() => {
      const toggle = screen.getByTestId('yolo-toggle');
      const isOff =
        toggle.getAttribute('data-state') === 'unchecked' ||
        toggle.getAttribute('aria-checked') === 'false' ||
        (toggle.getAttribute('data-state') !== 'checked' &&
          toggle.getAttribute('aria-checked') !== 'true');
      expect(isOff).toBe(true);
    });
  });

  it('B2-4: launch payload panes all have autoApprove:true when toggle is ON', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'pane.autoApprove.default.ws-42') return '1';
      return null;
    });

    await act(async () => {
      await renderLauncher(makeWorkspace());
    });

    // Navigate to the agents step so AgentsStep mock fires onSkipChange(true),
    // which enables the launch button (skipAgents=true).
    await act(async () => {
      fireEvent.click(screen.getByTestId('jump-agents'));
      // Pump microtasks for the useEffect inside the AgentsStep mock and the
      // kv async read.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Click launch button.
    const launchBtn = screen.getByRole('button', { name: /launch|open.*shell/i });
    await act(async () => {
      fireEvent.click(launchBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspacesLaunchMock).toHaveBeenCalledOnce();
    const calledPlan = workspacesLaunchMock.mock.calls[0][0] as { panes: Array<{ autoApprove?: boolean }> };
    expect(calledPlan.panes.every((p) => p.autoApprove === true)).toBe(true);
  });

  it('B2-5: launch payload panes have autoApprove:false when toggle is OFF', async () => {
    kvGetMock.mockResolvedValue(null); // OFF

    await act(async () => {
      await renderLauncher(makeWorkspace());
    });

    // Navigate to agents step to enable launch.
    await act(async () => {
      fireEvent.click(screen.getByTestId('jump-agents'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const launchBtn = screen.getByRole('button', { name: /launch|open.*shell/i });
    await act(async () => {
      fireEvent.click(launchBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspacesLaunchMock).toHaveBeenCalledOnce();
    const calledPlan = workspacesLaunchMock.mock.calls[0][0] as { panes: Array<{ autoApprove?: boolean }> };
    expect(calledPlan.panes.every((p) => p.autoApprove !== true)).toBe(true);
  });

  it('B2-6: toggling ON persists kv.set with "1"', async () => {
    kvGetMock.mockResolvedValue(null); // starts OFF

    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => { await Promise.resolve(); });

    const toggle = screen.getByTestId('yolo-toggle');
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(kvSetMock).toHaveBeenCalledWith('pane.autoApprove.default.ws-42', '1');
  });

  it('B2-7: toggling OFF persists kv.set with "0"', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'pane.autoApprove.default.ws-42') return '1';
      return null;
    });

    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const toggle = screen.getByTestId('yolo-toggle');
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(kvSetMock).toHaveBeenCalledWith('pane.autoApprove.default.ws-42', '0');
  });
});

// ---------------------------------------------------------------------------
// N1 — intent-first, mode-aware launcher flow
// ---------------------------------------------------------------------------

describe('WorkspaceLauncher — N1 mode-aware flow', () => {
  it('N1-1: defaults to the SigmaLink grid mode showing all four steps', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    const stepper = screen.getByTestId('stepper');
    expect(stepper.getAttribute('data-steps')).toBe('start,layout,agents,sessions');
  });

  it('N1-2: switching to single mode collapses the stepper to Start only', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-single'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('stepper').getAttribute('data-steps')).toBe('start');
  });

  it('N1-3: switching to swarm mode collapses the stepper to Start only', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-swarm'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('stepper').getAttribute('data-steps')).toBe('start');
  });

  it('N1-4: single mode launches exactly ONE shell pane via workspaces.launch', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-single'));
      await Promise.resolve();
      await Promise.resolve();
    });

    const launchBtn = screen.getByRole('button', { name: /open 1 terminal|launch 1 agent/i });
    await act(async () => {
      fireEvent.click(launchBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspacesLaunchMock).toHaveBeenCalledOnce();
    const plan = workspacesLaunchMock.mock.calls[0][0] as {
      preset: number;
      panes: Array<{ providerId: string }>;
    };
    expect(plan.preset).toBe(1);
    expect(plan.panes).toHaveLength(1);
    expect(plan.panes[0].providerId).toBe('shell');
  });

  it('N1-5: swarm mode routes to the Swarm Room WITHOUT calling workspaces.launch', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-swarm'));
      await Promise.resolve();
    });

    const launchBtn = screen.getByRole('button', { name: /open swarm room/i });
    await act(async () => {
      fireEvent.click(launchBtn);
      await Promise.resolve();
    });

    expect(workspacesLaunchMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'swarm' });
  });

  it('N1-6: the Yolo toggle is hidden for swarm mode (no agent panes spawned there)', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    // Grid (default) shows it.
    expect(screen.queryByTestId('yolo-toggle')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-swarm'));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('yolo-toggle')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Original buildPaneResumePlanArray tests
// ---------------------------------------------------------------------------

describe('buildPaneResumePlanArray — Bug B regression guard', () => {
  it('returns an empty array when no panes have selections', () => {
    const result = buildPaneResumePlanArray(4, {});
    expect(result).toEqual([]);
  });

  it('returns an empty array when every pane is set to null (New session)', () => {
    const result = buildPaneResumePlanArray(4, { 0: null, 1: null, 2: null, 3: null });
    expect(result).toEqual([]);
  });

  it('includes only panes with a non-null sessionId', () => {
    const result = buildPaneResumePlanArray(4, {
      0: 'sess-claude',
      1: null,
      2: 'sess-gemini',
      3: null,
    });
    expect(result).toEqual([
      { paneIndex: 0, sessionId: 'sess-claude' },
      { paneIndex: 2, sessionId: 'sess-gemini' },
    ]);
  });

  it('emits the entries as a top-level array (NOT inside each pane)', () => {
    const result = buildPaneResumePlanArray(2, { 0: 'a', 1: 'b' });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty('paneIndex');
    expect(result[0]).toHaveProperty('sessionId');
    expect(result[1]).toHaveProperty('paneIndex');
    expect(result[1]).toHaveProperty('sessionId');
  });

  it('respects paneCount: out-of-range selections are dropped', () => {
    // Operator selected sessions for 4 panes, then changed preset down to 2.
    // The helper must clamp to the new pane count so we don't send stale ids.
    const result = buildPaneResumePlanArray(2, {
      0: 'sess-0',
      1: 'sess-1',
      2: 'sess-2-stale',
      3: 'sess-3-stale',
    });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.paneIndex)).toEqual([0, 1]);
  });

  it('does not include undefined-key panes (user never visited SessionStep)', () => {
    // Skip-agents flow: the user clicks Launch directly from AgentsStep.
    // `paneResumePlan` stays at `{}`. The helper should return empty so the
    // backend spawns fresh and never injects resume args.
    const result = buildPaneResumePlanArray(4, {});
    expect(result).toEqual([]);
  });

  // Production-bug reproduction: the user picked 4 sessions, hit Launch, and
  // every pane spawned fresh because the helper output never landed on the
  // top-level plan. This test pins the exact shape the backend reads.
  it('matches the shape `executeLaunchPlan` reads via `paneResumePlan.find()`', () => {
    const result = buildPaneResumePlanArray(4, {
      0: 'claude-uuid',
      1: 'codex-uuid',
      2: 'gemini-uuid',
      3: 'kimi-uuid',
    });
    // Mirror the launcher.ts lookup: `plan.paneResumePlan?.find(r => r.paneIndex === pane.paneIndex)`
    expect(result.find((r) => r.paneIndex === 0)?.sessionId).toBe('claude-uuid');
    expect(result.find((r) => r.paneIndex === 1)?.sessionId).toBe('codex-uuid');
    expect(result.find((r) => r.paneIndex === 2)?.sessionId).toBe('gemini-uuid');
    expect(result.find((r) => r.paneIndex === 3)?.sessionId).toBe('kimi-uuid');
  });
});
