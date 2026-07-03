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
import {
  buildPaneResumePlanArray,
  buildSafeRamBrakePlan,
  inferResumeGridPreset,
} from './Launcher';
import type { SessionRiskReport } from '@/shared/router-shape';

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
function makeLowRiskReport(): SessionRiskReport {
  return {
  providerId: 'claude',
  cwd: '/tmp/test-ws',
  externalSessionId: null,
  sessionFilePath: null,
  sessionBytes: 0,
  lineCount: 0,
  ageMs: null,
  estimatedTextBytes: 0,
  estimatedTokens: null,
  riskLevel: 'low',
  reasons: [],
  };
}
const ramBrakeSessionRiskMock = vi.fn<(input: unknown) => Promise<SessionRiskReport>>(
  async () => makeLowRiskReport(),
);
let agentsStepBehavior: 'skip' | 'claude-grid' = 'skip';
let sessionSelectionsSeed: Record<number, string | null> = {};

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
    ramBrake: { sessionRisk: (input: unknown) => ramBrakeSessionRiskMock(input) },
    swarms: { list: async () => [] },
    design: { createCanvas: async () => ({}) },
    browser: { getState: async () => ({ tabs: [] }) },
  },
  // minimal-chrome — LauncherLanding reads `rpcSilent.kv.get('canvas.gaSign')`
  // on mount for the SigmaCanvas ALPHA gate. Provide a silent stub.
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
// minimal-chrome — LauncherLanding (the intent landing) renders for REAL so the
// mode rows carry their real `intent-card-<mode>` test-ids; routing tests click
// those rows to leave the landing and enter the mode-aware wizard.
vi.mock('./Stepper', () => ({
  // N1 — the mode-aware Stepper now receives a `steps` array; the stub renders
  // the visible step ids so routing tests can assert which steps show.
  Stepper: ({ steps, onJump }: { steps: string[]; onJump: (s: string) => void }) => (
    <div data-testid="stepper" data-steps={steps.join(',')}>
      <button data-testid="jump-agents" onClick={() => onJump('agents')}>agents</button>
      <button data-testid="jump-sessions" onClick={() => onJump('sessions')}>sessions</button>
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
    AgentsStep: ({
      onCountsChange,
      onSkipChange,
    }: {
      onCountsChange: (v: Record<string, number>) => void;
      onSkipChange: (v: boolean) => void;
    }) => {
      useEffect(() => {
        if (agentsStepBehavior === 'claude-grid') {
          onSkipChange(false);
          onCountsChange({ claude: 4 });
        } else {
          onSkipChange(true);
        }
      }, [onCountsChange, onSkipChange]);
      return <div data-testid="agents-step" />;
    },
  };
});
vi.mock('./SessionStep', async () => {
  const { useEffect } = await import('react');
  return {
  SessionStep: ({ onSelectionsChange }: { onSelectionsChange: (v: Record<number, string | null>) => void }) => {
    useEffect(() => {
      onSelectionsChange(sessionSelectionsSeed);
    }, [onSelectionsChange]);
    return <div data-testid="session-step" />;
  },
  fetchLastResumePlan: async () => [],
};
});

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

import type { LaunchPlan, Workspace } from '@/shared/types';

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

// minimal-chrome — render the launcher and leave the intent landing so the
// mode-aware wizard (grid mode by default) is mounted. The launcher now opens
// on the landing, so legacy tests that assert on wizard toggles/steps must
// first click a mode row to enter the wizard.
async function renderAndEnterWizard(activeWorkspace: Workspace | null = null) {
  // Own the act() wrapping here (callers do NOT wrap this): render inside one
  // act so its DOM commit flushes when the act completes, THEN click the
  // landing's default mode row in a second act to enter the mode-aware wizard.
  // (Querying the landing inside the render act observes an un-flushed DOM under
  // React 19's reentrant-act deferral.)
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = await renderLauncher(activeWorkspace);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('intent-card-space'));
    await Promise.resolve();
  });
  return result!;
}

beforeEach(() => {
  kvGetMock.mockReset().mockResolvedValue(null);
  kvSetMock.mockReset().mockResolvedValue(undefined);
  workspacesLaunchMock.mockReset().mockResolvedValue({ sessions: [] });
  ramBrakeSessionRiskMock.mockReset().mockResolvedValue(makeLowRiskReport());
  agentsStepBehavior = 'skip';
  sessionSelectionsSeed = {};
  dispatchMock.mockReset();
  // Use real timers for async kv reads in tests; individual tests that need
  // fake timers will call vi.useFakeTimers() themselves.
});

describe('WorkspaceLauncher — Phase 2 RAM Brake resume risk', () => {
  it('buildSafeRamBrakePlan drops risky resume ids and launches that pane with no MCP', () => {
    const plan = {
      workspaceRoot: '/tmp/test-ws',
      panes: [
        { paneIndex: 0, providerId: 'claude' },
        { paneIndex: 1, providerId: 'codex' },
      ],
      paneResumePlan: [
        { paneIndex: 0, sessionId: '37846eca-4143-4f3b-a1b5-5fe919ddf2b3' },
        { paneIndex: 1, sessionId: 'codex-session' },
      ],
    } as LaunchPlan;

    const safe = buildSafeRamBrakePlan(plan, [0]);

    expect(safe.paneResumePlan).toEqual([{ paneIndex: 1, sessionId: 'codex-session' }]);
    expect(safe.panes[0]).toMatchObject({
      paneIndex: 0,
      providerId: 'claude',
      launchMode: 'fresh',
      mcpLaunchMode: 'none',
    });
    expect(safe.panes[1]).toEqual(plan.panes[1]);
  });

  it('shows a high-risk resume prompt before launching risky Claude sessions', async () => {
    agentsStepBehavior = 'claude-grid';
    sessionSelectionsSeed = {
      0: '37846eca-4143-4f3b-a1b5-5fe919ddf2b3',
    };
    ramBrakeSessionRiskMock.mockResolvedValue({
      providerId: 'claude',
      cwd: '/tmp/test-ws',
      externalSessionId: '37846eca-4143-4f3b-a1b5-5fe919ddf2b3',
      sessionFilePath: '/tmp/session.jsonl',
      sessionBytes: 5 * 1024 * 1024,
      lineCount: 1400,
      ageMs: 0,
      estimatedTextBytes: 4_500_000,
      estimatedTokens: 1_125_000,
      riskLevel: 'high',
      reasons: ['large-jsonl'],
    });

    await renderAndEnterWizard(makeWorkspace());
    await act(async () => {
      fireEvent.click(screen.getByTestId('jump-agents'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('jump-sessions'));
      await Promise.resolve();
      await Promise.resolve();
    });

    const launchBtn = screen.getByRole('button', { name: /launch|open.*shell/i });
    await act(async () => {
      fireEvent.click(launchBtn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspacesLaunchMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId('session-risk-launch-prompt')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start fresh.*no mcp/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspacesLaunchMock).toHaveBeenCalledOnce();
    const safePlan = workspacesLaunchMock.mock.calls[0][0] as LaunchPlan;
    expect(safePlan.paneResumePlan).toEqual(undefined);
    expect(safePlan.panes[0]).toMatchObject({ launchMode: 'fresh', mcpLaunchMode: 'none' });
  });
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
    await renderAndEnterWizard(makeWorkspace());
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
    await renderAndEnterWizard(makeWorkspace());
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
    await renderAndEnterWizard(makeWorkspace());
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

    await renderAndEnterWizard(makeWorkspace());

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

    await renderAndEnterWizard(makeWorkspace());

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

    await renderAndEnterWizard(makeWorkspace());
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

    await renderAndEnterWizard(makeWorkspace());
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

describe('WorkspaceLauncher — minimal-chrome landing', () => {
  it('opens on the intent landing (minimal-chrome)', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    expect(await screen.findByText('Command the fleet.')).toBeTruthy();
    // The wizard card (mode-aware Stepper + Start step) is absent on the landing.
    expect(screen.queryByTestId('stepper')).toBeNull();
    expect(screen.queryByTestId('start-step')).toBeNull();
  });

  it('clicking a mode row advances to the folder step', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    // Starts on the landing — the wizard's Start step is not shown yet.
    expect(screen.queryByTestId('start-step')).toBeNull();
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-space'));
      await Promise.resolve();
    });
    // StartStep (stubbed) renders once we advance off the landing.
    expect(screen.getByTestId('start-step')).toBeTruthy();
    expect(screen.getByTestId('stepper')).toBeTruthy();
  });

  it('clicking the CURRENT mode row still advances (no changeMode early-return trap)', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    // 'space' is the default mode; re-picking it must STILL advance to Start
    // (pickIntent always advances, unlike changeMode which early-returns).
    expect(screen.queryByTestId('start-step')).toBeNull();
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-space'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('start-step')).toBeTruthy();
  });
});

describe('WorkspaceLauncher — N1 mode-aware flow', () => {
  it('N1-1: defaults to the SigmaLink grid mode showing all four steps', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    // Enter the wizard from the landing (default mode = 'space').
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-space'));
      await Promise.resolve();
    });
    const stepper = screen.getByTestId('stepper');
    expect(stepper.getAttribute('data-steps')).toBe('start,layout,agents,sessions');
  });

  it('N1-2: switching to single mode collapses the stepper to Start only', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-single'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('stepper').getAttribute('data-steps')).toBe('start');
  });

  it('N1-3: switching to swarm mode collapses the stepper to Start only', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-swarm'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('stepper').getAttribute('data-steps')).toBe('start');
  });

  it('N1-4: single mode launches exactly ONE shell pane via workspaces.launch', async () => {
    await act(async () => {
      await renderLauncher(makeWorkspace());
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-single'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // N1 review (Medium) — single mode is ALWAYS a plain terminal: the label is
    // "Open 1 terminal" (never the agent variant), and the launched pane is a
    // shell regardless of any stale grid counts (singleShell = mode==='single').
    const launchBtn = screen.getByRole('button', { name: /open 1 terminal/i });
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
      fireEvent.click(await screen.findByTestId('intent-card-swarm'));
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
    // Grid (default) mode shows the toggle once we enter the wizard.
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-space'));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('yolo-toggle')).toBeTruthy();
    // Back to the landing, then pick swarm — the toggle is gone.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('intent-card-swarm'));
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

// ---------------------------------------------------------------------------
// Phase 13 — closed panes are filtered out of lastResumePlan (closed_at IS
// NULL), so paneIndex can GAP (close the middle pane of 3 → rows at slots
// [0, 2]). The resume-jump used to infer the grid preset from plan.length,
// which under-sizes the grid and silently drops trailing sessions in
// buildPaneResumePlanArray's 0..preset-1 scan.
// ---------------------------------------------------------------------------

describe('inferResumeGridPreset — closed-pane gaps (Phase 13 regression guard)', () => {
  it('documents the old bug: a count-sized scan drops the session at the gapped slot', () => {
    // Pre-fix behavior: preset = plan.length = 2 → slot 2 never scanned.
    const dropped = buildPaneResumePlanArray(2, { 0: 'A', 2: 'C' });
    expect(dropped).toEqual([{ paneIndex: 0, sessionId: 'A' }]);
  });

  it('sizes by the highest surviving slot, snapping to the next valid preset', () => {
    // maxSlot 2 → needs ≥3 panes → snaps to preset 4.
    const preset = inferResumeGridPreset([{ paneIndex: 0 }, { paneIndex: 2 }]);
    expect(preset).toBeGreaterThanOrEqual(3);
    expect(preset).toBe(4);
  });

  it('the gapped plan keeps BOTH sessions through buildPaneResumePlanArray (C at slot 2)', () => {
    // Mirror chooseExisting's resume-jump pipeline end-to-end.
    const plan = [
      { paneIndex: 0, sessionId: 'A' },
      { paneIndex: 2, sessionId: 'C' },
    ];
    const hydrated: Record<number, string | null> = {};
    for (const entry of plan) hydrated[entry.paneIndex] = entry.sessionId;
    const result = buildPaneResumePlanArray(inferResumeGridPreset(plan), hydrated);
    expect(result).toContainEqual({ paneIndex: 0, sessionId: 'A' });
    expect(result).toContainEqual({ paneIndex: 2, sessionId: 'C' });
  });

  it('contiguous plans keep their exact preset when it is valid', () => {
    expect(inferResumeGridPreset([{ paneIndex: 0 }])).toBe(1);
    expect(inferResumeGridPreset([{ paneIndex: 0 }, { paneIndex: 1 }])).toBe(2);
  });

  it('snaps an invalid pane count up to the next preset (3 → 4, 5 → 6)', () => {
    expect(
      inferResumeGridPreset([{ paneIndex: 0 }, { paneIndex: 1 }, { paneIndex: 2 }]),
    ).toBe(4);
    expect(inferResumeGridPreset([{ paneIndex: 4 }])).toBe(6);
  });

  it('caps at the largest grid preset (20) for out-of-range slots', () => {
    expect(inferResumeGridPreset([{ paneIndex: 25 }])).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// DEV-W3b — In-place worktree mode toggle
// ---------------------------------------------------------------------------

describe('WorkspaceLauncher — in-place worktree mode toggle (DEV-W3b)', () => {
  it('W3b-1: inplace-toggle renders with collision warning text', async () => {
    await renderAndEnterWizard(makeWorkspace());
    const toggle = screen.getByTestId('inplace-toggle');
    expect(toggle).toBeTruthy();
    const inPlaceTexts = screen.getAllByText(/in-place/i);
    expect(inPlaceTexts.length).toBeGreaterThan(0);
    const collisionWarning = screen.queryByText(/collide/i) ?? screen.queryByText(/working tree/i);
    expect(collisionWarning).toBeTruthy();
  });

  it('W3b-2: toggle defaults ON when kv returns "in-place" for workspace', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'workspace.worktreeMode.ws-42') return 'in-place';
      return null;
    });
    await renderAndEnterWizard(makeWorkspace());
    await waitFor(() => {
      const toggle = screen.getByTestId('inplace-toggle');
      expect(
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true',
      ).toBe(true);
    });
  });

  it('W3b-3: toggle defaults OFF when kv returns null', async () => {
    kvGetMock.mockResolvedValue(null);
    await renderAndEnterWizard(makeWorkspace());
    await waitFor(() => {
      const toggle = screen.getByTestId('inplace-toggle');
      const isOff =
        toggle.getAttribute('data-state') === 'unchecked' ||
        toggle.getAttribute('aria-checked') === 'false' ||
        (toggle.getAttribute('data-state') !== 'checked' &&
          toggle.getAttribute('aria-checked') !== 'true');
      expect(isOff).toBe(true);
    });
  });

  it('W3b-4: toggling ON persists kv.set with "in-place"', async () => {
    kvGetMock.mockResolvedValue(null);
    await renderAndEnterWizard(makeWorkspace());
    // Toggle it on.
    await act(async () => {
      fireEvent.click(screen.getByTestId('inplace-toggle'));
    });
    expect(kvSetMock).toHaveBeenCalledWith('workspace.worktreeMode.ws-42', 'in-place');
  });

  it('W3b-5: toggling OFF persists kv.set with "worktree"', async () => {
    kvGetMock.mockImplementation(async (key: string) => {
      if (key === 'workspace.worktreeMode.ws-42') return 'in-place';
      return null;
    });
    await renderAndEnterWizard(makeWorkspace());
    // Wait for the kv hydration to set toggle ON.
    await waitFor(() => {
      const toggle = screen.getByTestId('inplace-toggle');
      expect(
        toggle.getAttribute('data-state') === 'checked' ||
        toggle.getAttribute('aria-checked') === 'true',
      ).toBe(true);
    });
    kvSetMock.mockClear();
    // Toggle it off.
    await act(async () => {
      fireEvent.click(screen.getByTestId('inplace-toggle'));
    });
    expect(kvSetMock).toHaveBeenCalledWith('workspace.worktreeMode.ws-42', 'worktree');
  });
});
