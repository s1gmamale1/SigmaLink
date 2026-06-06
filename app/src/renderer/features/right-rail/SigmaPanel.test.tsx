// @vitest-environment jsdom
//
// BSP-O1/BSP-O2 — SigmaPanel tests.
//
// Covers:
//   - Empty state renders when no active swarm
//   - Canvas sub-tab renders agent list with status glyphs
//   - Switching to Review sub-tab mounts ToolCallInspector
//   - Rail registry: 'sigma' is in VALID_TABS and RightRailTabId union

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentSession, Swarm, SwarmAgent } from '@/shared/types';
import { VALID_TABS } from './RightRailContext.data';

// ─── Polyfills ────────────────────────────────────────────────────────────────
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

// ─── Mock rpc ─────────────────────────────────────────────────────────────────
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    usage: {
      sessionSummary: vi.fn().mockResolvedValue({
        inputTokens: 0,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.001,
        turnCount: 1,
      }),
    },
  },
  onEvent: vi.fn().mockReturnValue(() => {}),
}));

// ─── Mock state ──────────────────────────────────────────────────────────────
type MockState = {
  activeWorkspaceId: string | null;
  activeSwarmId: string | null;
  swarmsByWorkspace: Record<string, Swarm[]>;
  sessions: AgentSession[];
};

let mockState: MockState;

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (selector: (s: unknown) => unknown) => selector(mockState),
  useAppDispatch: () => vi.fn(),
}));

// ─── Mock RightRail context (SigmaPanel reads activeTab for the M4 poll gate) ──
// Keep the rest of the module real (VALID_TABS is asserted below). Return
// activeTab='sigma' so the live-stats poll is enabled under test.
vi.mock('./RightRailContext.data', async (importActual) => {
  const actual = await importActual<typeof import('./RightRailContext.data')>();
  return {
    ...actual,
    useRightRail: () => ({
      activeTab: 'sigma' as const,
      setActiveTab: vi.fn(),
      railOpen: true,
      setRailOpen: vi.fn(),
      toggleRail: vi.fn(),
    }),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeAgent(overrides?: Partial<SwarmAgent>): SwarmAgent {
  return {
    id: 'agent-1',
    swarmId: 'swarm-1',
    role: 'builder',
    roleIndex: 1,
    providerId: 'claude',
    sessionId: 'sess-1',
    status: 'busy',
    inboxPath: '',
    agentKey: 'builder-1',
    autoApprove: false,
    ...overrides,
  };
}

function makeSwarm(agents: SwarmAgent[]): Swarm {
  return {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Test Swarm',
    mission: 'Build something',
    preset: 'custom',
    status: 'running',
    createdAt: 0,
    endedAt: null,
    agents,
  };
}

function makeSession(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    status: 'running',
    providerId: 'claude',
    cwd: '/tmp',
    branch: null,
    startedAt: Date.now(),
    worktreePath: null,
    ...overrides,
  };
}

function defaultState(): MockState {
  const agent = makeAgent();
  const swarm = makeSwarm([agent]);
  const session = makeSession();
  return {
    activeWorkspaceId: 'ws-1',
    activeSwarmId: 'swarm-1',
    swarmsByWorkspace: { 'ws-1': [swarm] },
    sessions: [session],
  };
}

// Import after mocks are wired.
import { SigmaPanel } from './SigmaPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── Rail registry tests ──────────────────────────────────────────────────────

describe('RightRailContext.data — registry', () => {
  it('includes "sigma" in VALID_TABS', () => {
    expect(VALID_TABS.has('sigma')).toBe(true);
  });

  it('VALID_TABS contains all six tabs', () => {
    expect(VALID_TABS.size).toBe(6);
    for (const id of ['browser', 'editor', 'jorvis', 'skills', 'swarm', 'sigma']) {
      expect(VALID_TABS.has(id as Parameters<typeof VALID_TABS.has>[0])).toBe(true);
    }
  });
});

// ─── SigmaPanel tests ─────────────────────────────────────────────────────────

describe('SigmaPanel', () => {
  it('renders the Canvas and Review sub-tab buttons', () => {
    mockState = defaultState();
    render(<SigmaPanel />);
    expect(screen.getByRole('tab', { name: 'Canvas' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Review' })).toBeTruthy();
  });

  it('Canvas sub-tab shows empty state when no active swarm', () => {
    mockState = {
      activeWorkspaceId: 'ws-1',
      activeSwarmId: null,
      swarmsByWorkspace: {},
      sessions: [],
    };
    render(<SigmaPanel />);
    expect(screen.getByText(/No active swarm/)).toBeTruthy();
  });

  it('Canvas sub-tab renders agent key and status', () => {
    mockState = defaultState();
    render(<SigmaPanel />);
    // Agent key visible in the list.
    expect(screen.getByText('builder-1')).toBeTruthy();
    // deriveStatus('busy','running') → label 'busy' for the agent row.
    expect(screen.getByText('busy')).toBeTruthy();
    // The swarm header still shows the swarm-level status ('running').
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
  });

  it('Canvas sub-tab shows numbered list (1.) for agent entries', () => {
    mockState = defaultState();
    render(<SigmaPanel />);
    expect(screen.getByText('1.')).toBeTruthy();
  });

  it('Canvas sub-tab shows the busy glyph (▶) for a busy agent on a running session', () => {
    // deriveStatus('busy','running') → '▶' (the default makeAgent is busy).
    mockState = defaultState();
    render(<SigmaPanel />);
    expect(screen.getByText('▶')).toBeTruthy();
  });

  it('Canvas sub-tab shows the idle glyph (○) for an idle agent with no session', () => {
    // deriveStatus('idle', undefined) → '○'.
    const agent = makeAgent({ status: 'idle', sessionId: null });
    const swarm = makeSwarm([agent]);
    mockState = {
      activeWorkspaceId: 'ws-1',
      activeSwarmId: 'swarm-1',
      swarmsByWorkspace: { 'ws-1': [swarm] },
      sessions: [],
    };
    render(<SigmaPanel />);
    expect(screen.getByText('○')).toBeTruthy();
  });

  it('clicking Review sub-tab switches to Review panel', () => {
    mockState = defaultState();
    render(<SigmaPanel />);
    const reviewTab = screen.getByRole('tab', { name: 'Review' });

    // Canvas is the default (aria-selected=true on Canvas).
    const canvasTab = screen.getByRole('tab', { name: 'Canvas' });
    expect(canvasTab.getAttribute('aria-selected')).toBe('true');
    expect(reviewTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(reviewTab);

    expect(reviewTab.getAttribute('aria-selected')).toBe('true');
    expect(canvasTab.getAttribute('aria-selected')).toBe('false');
  });

  it('Review sub-tab renders ToolCallInspector (Tool calls section)', () => {
    mockState = defaultState();
    render(<SigmaPanel />);
    // Switch to Review.
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    // ToolCallInspector renders an aria-label="Tool calls" section.
    expect(screen.getByLabelText('Tool calls')).toBeTruthy();
  });

  it('Canvas sub-tab shows mission text when swarm is active', () => {
    mockState = defaultState();
    render(<SigmaPanel />);
    expect(screen.getByText('Build something')).toBeTruthy();
  });
});
