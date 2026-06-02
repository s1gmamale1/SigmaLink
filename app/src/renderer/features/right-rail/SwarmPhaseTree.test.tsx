// @vitest-environment jsdom
//
// SwarmPhaseTree — FEAT-6 unit coverage.
// Verifies:
//   1. Phase grouping: roles map to correct phase headers.
//   2. Status derivation: agent + PTY session status display correctly.
//   3. Click-to-focus: clicking a row dispatches SET_ACTIVE_SESSION.
//   4. Collapse toggle: clicking phase header hides/shows its rows.
//   5. Accessibility: rows are buttons, phase headers report aria-expanded.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentSession, Swarm, SwarmAgent } from '@/shared/types';
import { SwarmPhaseTree, type SwarmPhaseTreeProps } from './SwarmPhaseTree';

// ─── Polyfills ────────────────────────────────────────────────────────────────
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

// ─── Mocks ────────────────────────────────────────────────────────────────────
const dispatchSpy = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => dispatchSpy,
  useAppStateSelector: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeAgent(
  overrides: Partial<SwarmAgent> & { role: SwarmAgent['role'] },
): SwarmAgent {
  const {
    role,
    roleIndex = 1,
    providerId = 'claude',
    sessionId,
    status = 'idle',
    ...rest
  } = overrides;
  return {
    id: `agent-${role}-${roleIndex}`,
    swarmId: 'swarm-1',
    role,
    roleIndex,
    providerId,
    sessionId: sessionId !== undefined ? sessionId : `sess-${role}-1`,
    status,
    inboxPath: '',
    agentKey: `${role}-${roleIndex}`,
    autoApprove: false,
    ...rest,
  };
}

function makeSwarm(agents: SwarmAgent[]): Swarm {
  return {
    id: 'swarm-1',
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

function makeSession(
  id: string,
  status: AgentSession['status'] = 'running',
): AgentSession {
  return {
    id,
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/tmp',
    branch: null,
    status,
    startedAt: 0,
    worktreePath: null,
  };
}

function renderTree(props: Partial<SwarmPhaseTreeProps> & { swarm: Swarm }) {
  const defaultProps: SwarmPhaseTreeProps = {
    swarm: props.swarm,
    sessions: props.sessions ?? [],
    messageCounts: props.messageCounts ?? {},
    lastActivity: props.lastActivity ?? {},
  };
  return render(<SwarmPhaseTree {...defaultProps} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  dispatchSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SwarmPhaseTree — phase grouping', () => {
  it('groups coordinator into "Orchestrate"', () => {
    const swarm = makeSwarm([makeAgent({ role: 'coordinator' })]);
    renderTree({ swarm });
    expect(screen.getByText('Orchestrate')).toBeTruthy();
  });

  it('groups builder into "Execute"', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm });
    expect(screen.getByText('Execute')).toBeTruthy();
  });

  it('groups reviewer into "Verify"', () => {
    const swarm = makeSwarm([makeAgent({ role: 'reviewer' })]);
    renderTree({ swarm });
    expect(screen.getByText('Verify')).toBeTruthy();
  });

  it('groups scout into "Scout"', () => {
    const swarm = makeSwarm([makeAgent({ role: 'scout' })]);
    renderTree({ swarm });
    expect(screen.getByText('Scout')).toBeTruthy();
  });

  it('renders all 4 phases when all roles present', () => {
    const swarm = makeSwarm([
      makeAgent({ role: 'coordinator' }),
      makeAgent({ role: 'builder' }),
      makeAgent({ role: 'reviewer' }),
      makeAgent({ role: 'scout' }),
    ]);
    renderTree({ swarm });
    expect(screen.getByText('Orchestrate')).toBeTruthy();
    expect(screen.getByText('Execute')).toBeTruthy();
    expect(screen.getByText('Verify')).toBeTruthy();
    expect(screen.getByText('Scout')).toBeTruthy();
  });

  it('shows agent count badge in phase header', () => {
    const swarm = makeSwarm([
      makeAgent({ role: 'builder', roleIndex: 1 }),
      makeAgent({ role: 'builder', roleIndex: 2 }),
    ]);
    renderTree({ swarm });
    // The "2" badge should be accessible (aria-label "2 agents")
    const badge = screen.getByLabelText('2 agents');
    expect(badge).toBeTruthy();
  });

  it('shows agentKey in expanded rows', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder', roleIndex: 1 })]);
    renderTree({ swarm });
    expect(screen.getByText('builder-1')).toBeTruthy();
  });

  it('shows provider in rows', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder', providerId: 'gemini' })]);
    renderTree({ swarm });
    expect(screen.getByText('gemini')).toBeTruthy();
  });
});

describe('SwarmPhaseTree — status derivation', () => {
  it('shows "busy" status for busy agent', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder', status: 'busy', sessionId: 'sess-1' })]);
    const sessions = [makeSession('sess-1', 'running')];
    renderTree({ swarm, sessions });
    // aria-label on status span
    expect(screen.getByLabelText('status: busy')).toBeTruthy();
  });

  it('shows "error" status when PTY session is in error state', () => {
    const swarm = makeSwarm([
      makeAgent({ role: 'builder', status: 'idle', sessionId: 'sess-err' }),
    ]);
    const sessions = [makeSession('sess-err', 'error')];
    renderTree({ swarm, sessions });
    // PTY error overrides agent idle status
    expect(screen.getByLabelText('status: error')).toBeTruthy();
  });

  it('shows "done" status for done agent with running session', () => {
    const swarm = makeSwarm([
      makeAgent({ role: 'reviewer', status: 'done', sessionId: 'sess-done' }),
    ]);
    const sessions = [makeSession('sess-done', 'running')];
    renderTree({ swarm, sessions });
    expect(screen.getByLabelText('status: done')).toBeTruthy();
  });

  it('shows "idle" status for idle agent', () => {
    const swarm = makeSwarm([makeAgent({ role: 'scout', status: 'idle', sessionId: 'sess-idle' })]);
    const sessions = [makeSession('sess-idle', 'running')];
    renderTree({ swarm, sessions });
    expect(screen.getByLabelText('status: idle')).toBeTruthy();
  });
});

describe('SwarmPhaseTree — click-to-focus', () => {
  it('dispatches SET_ACTIVE_SESSION when clicking an agent row', () => {
    const sessionId = 'sess-click';
    const swarm = makeSwarm([
      makeAgent({ role: 'builder', sessionId }),
    ]);
    renderTree({ swarm, sessions: [makeSession(sessionId)] });
    // The button has aria-label "Focus builder-1 — idle"
    const btn = screen.getByLabelText(/Focus builder-1/);
    fireEvent.click(btn);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'SET_ACTIVE_SESSION', id: sessionId });
  });

  it('does not dispatch when agent has no sessionId', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder', sessionId: null })]);
    renderTree({ swarm });
    const btn = screen.getByLabelText(/Focus builder-1/);
    fireEvent.click(btn);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('SwarmPhaseTree — collapse toggle', () => {
  it('starts expanded — agent rows visible by default', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm });
    expect(screen.getByText('builder-1')).toBeTruthy();
  });

  it('hides rows when phase header is clicked', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm });
    const header = screen.getByText('Execute').closest('button')!;
    fireEvent.click(header);
    expect(screen.queryByText('builder-1')).toBeNull();
  });

  it('re-shows rows when phase header is clicked again', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm });
    const header = screen.getByText('Execute').closest('button')!;
    fireEvent.click(header); // collapse
    fireEvent.click(header); // re-expand
    expect(screen.getByText('builder-1')).toBeTruthy();
  });

  it('sets aria-expanded=false on header when collapsed', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm });
    const header = screen.getByText('Execute').closest('button')!;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SwarmPhaseTree — message counts and activity', () => {
  it('shows message count when non-zero', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm, messageCounts: { 'builder-1': 5 } });
    expect(screen.getByText('5 msgs')).toBeTruthy();
  });

  it('shows last activity body truncated', () => {
    const swarm = makeSwarm([makeAgent({ role: 'builder' })]);
    renderTree({ swarm, lastActivity: { 'builder-1': 'compiling main.ts' } });
    expect(screen.getByText('compiling main.ts')).toBeTruthy();
  });
});

describe('SwarmPhaseTree — empty state', () => {
  it('shows placeholder when swarm has no agents', () => {
    const swarm = makeSwarm([]);
    renderTree({ swarm });
    expect(screen.getByText(/No agents in swarm/)).toBeTruthy();
  });
});
