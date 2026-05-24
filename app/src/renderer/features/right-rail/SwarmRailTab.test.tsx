// @vitest-environment jsdom
//
// SwarmRailTab — C-2 + C-4 glue coverage.
// Verifies:
//   - Agent key visible in roster (C-2)
//   - Last activity from swarmMessages visible (C-4)
//   - Clicking an agent card dispatches SET_ACTIVE_SESSION with the sessionId

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Swarm, SwarmAgent, SwarmMessage } from '@/shared/types';

// ─── Radix / jsdom polyfills ────────────────────────────────────────────────
beforeAll(() => {
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
});

// ─── Mock canDo (required by RoleRoster) ────────────────────────────────────
vi.mock('@/renderer/lib/canDo', () => ({
  useCanDo: () => () => true,
}));

// ─── Mock rpc ────────────────────────────────────────────────────────────────
const tailMock = vi.fn().mockResolvedValue([]);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    swarms: {
      tail: (...args: unknown[]) => tailMock(...args),
      broadcast: vi.fn(),
      sendMessage: vi.fn(),
    },
    providers: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

// ─── Mock drag-region ────────────────────────────────────────────────────────
vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

// ─── Minimal state mock — mirrors CommandRoom.test.tsx pattern ───────────────
type MockState = {
  activeWorkspaceId: string | null;
  activeSwarmId: string | null;
  swarmsByWorkspace: Record<string, Swarm[]>;
  swarmMessages: Record<string, SwarmMessage[]>;
};

let mockState: MockState;
const dispatchSpy = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchSpy,
  useAppStateSelector: (selector: (s: unknown) => unknown) => selector(mockState),
  // MailboxBubble uses useAppState(); provide a minimal stub.
  useAppState: () => ({ state: mockState, dispatch: dispatchSpy }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeAgent(): SwarmAgent {
  return {
    id: 'a1',
    swarmId: 's1',
    role: 'builder',
    roleIndex: 1,
    providerId: 'claude',
    sessionId: 'sess-1',
    status: 'busy',
    inboxPath: '',
    agentKey: 'builder-1',
    autoApprove: false,
  };
}

function makeSwarm(agents: SwarmAgent[]): Swarm {
  return {
    id: 's1',
    workspaceId: 'ws-1',
    name: 'Test Swarm',
    mission: 'testing',
    preset: 'custom',
    status: 'running',
    createdAt: 0,
    endedAt: null,
    agents,
  };
}

function makeMessage(): SwarmMessage {
  return {
    id: 'm1',
    swarmId: 's1',
    fromAgent: 'builder-1',
    toAgent: '*',
    kind: 'STATUS',
    body: 'compiling',
    ts: 1,
    readAt: undefined,
  };
}

function defaultState(): MockState {
  const agent = makeAgent();
  const swarm = makeSwarm([agent]);
  const message = makeMessage();
  return {
    activeWorkspaceId: 'ws-1',
    activeSwarmId: 's1',
    swarmsByWorkspace: { 'ws-1': [swarm] },
    swarmMessages: { s1: [message] },
  };
}

// Import component after all mocks are wired.
import { SwarmRailTab } from './SwarmRailTab';

beforeEach(() => {
  mockState = defaultState();
  dispatchSpy.mockReset();
  tailMock.mockReset();
  tailMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SwarmRailTab', () => {
  it('shows agent key in roster (C-2) and last activity body (C-4)', () => {
    render(<SwarmRailTab />);
    // builder-1 appears in roster + chat; getAllByText confirms at least one.
    expect(screen.getAllByText(/builder-1/).length).toBeGreaterThan(0);
    // 'compiling' appears as lastActivity in the roster card and in the message bubble.
    expect(screen.getAllByText(/compiling/).length).toBeGreaterThan(0);
  });

  it('dispatches SET_ACTIVE_SESSION when agent card clicked (click-to-focus)', () => {
    render(<SwarmRailTab />);
    // The roster card has role="button" when onFocusPane is provided + agent has sessionId.
    // Use getAllByText to find one occurrence of "builder-1" inside a card, then walk to its card.
    const allBuilderTexts = screen.getAllByText(/builder-1/);
    // Find the span inside the role="button" card (the agentKey span at bottom of card).
    const agentCard = allBuilderTexts
      .map((el) => el.closest('[role="button"]'))
      .find((el) => el !== null) as HTMLElement | undefined;
    expect(agentCard).toBeTruthy();
    fireEvent.click(agentCard!);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'SET_ACTIVE_SESSION', id: 'sess-1' });
  });

  it('shows placeholder when no active swarm', () => {
    mockState = {
      activeWorkspaceId: 'ws-1',
      activeSwarmId: null,
      swarmsByWorkspace: {},
      swarmMessages: {},
    };
    render(<SwarmRailTab />);
    expect(screen.getByText(/No active swarm/)).toBeTruthy();
  });
});
