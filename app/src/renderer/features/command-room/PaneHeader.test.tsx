// @vitest-environment jsdom
//
// Phase 4 Lane A — PaneHeader unit coverage. Validates the BridgeSpace-faithful
// pane header: title pill (drag handle, status glyph, alias·effort) + icon
// cluster (gear, fullscreen, split, minimise, close). All metadata is relocated
// to the gear popover (PaneGearPopoverBody).
//
// BSP-V2 — also covers the live cost + tok/s estimate badge.

import { describe, expect, it, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: {
      brief: vi.fn().mockResolvedValue(undefined),
      setDisplayProvider: vi.fn().mockResolvedValue({ ok: true }),
    },
    kv: {
      set: vi.fn().mockResolvedValue(undefined),
    },
    usage: {
      sessionSummary: vi.fn().mockResolvedValue({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: null,
        turnCount: 0,
      }),
    },
  },
  rpcSilent: {
    ruflo: { daemonStatus: vi.fn().mockResolvedValue([]) },
    kv: {
      get: vi.fn().mockResolvedValue('1'), // default: coachmark already seen
    },
  },
  // CheckpointPanel uses onEvent to subscribe to git:checkpoints-changed
  onEvent: vi.fn(() => () => undefined),
}));

// BSP-V2 — mock usePaneLiveStats so PaneHeader badge tests are isolated from
// the hook's polling logic. Individual tests override via mockReturnValue.
vi.mock('./usePaneLiveStats', () => ({
  usePaneLiveStats: vi.fn(() => ({
    totalCostUsd: null,
    estTokPerSec: null,
    hasData: false,
  })),
}));

// Mock useRufloDaemonHealth so PaneHeader tests are isolated from the hook's
// polling logic. Default to 'running' state; individual tests override.
vi.mock('./useRufloDaemonHealth', () => ({
  useRufloDaemonHealth: vi.fn(() => ({ state: 'running', detail: 'running · port 53112' })),
}));

import { PaneHeader } from './PaneHeader';
import type { AgentSession } from '@/shared/types';
import type { RufloDaemonHealth } from './useRufloDaemonHealth';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';
import { usePaneLiveStats } from './usePaneLiveStats';
import type { PaneLiveStats } from './usePaneLiveStats';

// Radix tooltip/popover uses ResizeObserver under the hood, which jsdom doesn't
// ship. A no-op polyfill is enough for our assertions.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {
        /* no-op */
      }
      unobserve() {
        /* no-op */
      }
      disconnect() {
        /* no-op */
      }
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) {
    proto.hasPointerCapture = () => false;
  }
  if (!proto.scrollIntoView) {
    proto.scrollIntoView = () => undefined;
  }
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/Users/test/code/example',
    branch: 'dev',
    status: 'running',
    startedAt: 1,
    worktreePath: null,
    ...overrides,
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    session: makeSession(),
    paneIndex: 1,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    providers: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
    onSplit: vi.fn(),
    onToggleMinimise: vi.fn(),
    isMinimised: false,
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    uncommitted: 3,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('PaneHeader (Phase 4 BridgeSpace strip)', () => {
  it('renders the title pill with alias and is the drag handle', () => {
    render(<PaneHeader {...baseProps()} />);
    const pill = screen.getByTestId('pane-title-pill');
    expect(pill.getAttribute('draggable')).toBe('true');
    // alias is deterministic from session.id via agentAlias
    expect(pill.textContent ?? '').toMatch(/\w+/);
  });

  it('shows a single status glyph (folded dots)', () => {
    render(<PaneHeader {...baseProps()} />);
    expect(screen.getByTestId('pane-status-glyph')).toBeTruthy();
    // the three legacy dots are gone from the bar
    expect(screen.queryByTestId('ruflo-health-dot')).toBeNull();
    expect(screen.queryByTestId('agent-short-id')).toBeNull();
  });

  it('exposes the icon cluster: gear, fullscreen, split, minimise, close', () => {
    const onToggleFullscreen = vi.fn();
    const onToggleMinimise = vi.fn();
    const onSplit = vi.fn();
    render(<PaneHeader {...baseProps({ onToggleFullscreen, onToggleMinimise, onSplit })} />);
    expect(screen.getByTestId('pane-gear')).toBeTruthy();
    expect(screen.getByLabelText('Fullscreen pane')).toBeTruthy();
    expect(screen.getByTestId('pane-split')).toBeTruthy();
    expect(screen.getByLabelText('Minimise pane')).toBeTruthy();
    expect(screen.getByLabelText('Close pane')).toBeTruthy();
  });

  it('opens the gear popover with relocated metadata + actions', async () => {
    render(<PaneHeader {...baseProps()} />);
    fireEvent.click(screen.getByTestId('pane-gear'));
    const pop = await screen.findByTestId('pane-gear-popover');
    expect(pop).toBeTruthy();
    // branch + model now live in the popover, not on the bar
    expect(pop.textContent ?? '').toMatch(/dev|feature/);
  });

  it('Close calls onClose', () => {
    const onClose = vi.fn();
    render(<PaneHeader {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByLabelText('Close pane'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fullscreen toggle calls onToggleFullscreen', () => {
    const onToggleFullscreen = vi.fn();
    render(<PaneHeader {...baseProps({ onToggleFullscreen })} />);
    fireEvent.click(screen.getByLabelText('Fullscreen pane'));
    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });

  it('minimise calls onToggleMinimise', () => {
    const onToggleMinimise = vi.fn();
    render(<PaneHeader {...baseProps({ onToggleMinimise })} />);
    fireEvent.click(screen.getByLabelText('Minimise pane'));
    expect(onToggleMinimise).toHaveBeenCalledOnce();
  });

  it('swaps minimise label to "Restore pane" when isMinimised=true', () => {
    const onToggleMinimise = vi.fn();
    render(<PaneHeader {...baseProps({ onToggleMinimise, isMinimised: true })} />);
    const btn = screen.getByLabelText('Restore pane');
    fireEvent.click(btn);
    expect(onToggleMinimise).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Minimise pane')).toBeNull();
  });

  it('swaps fullscreen to "Exit fullscreen (Esc)" when isFullscreen=true', () => {
    const onToggleFullscreen = vi.fn();
    render(<PaneHeader {...baseProps({ onToggleFullscreen, isFullscreen: true })} />);
    const btn = screen.getByLabelText('Exit fullscreen (Esc)');
    fireEvent.click(btn);
    expect(onToggleFullscreen).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Fullscreen pane')).toBeNull();
  });

  it('falls back to onFocus when no onToggleFullscreen is supplied', () => {
    const onFocus = vi.fn();
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={onFocus}
        onClose={vi.fn()}
      />,
    );
    // With no onToggleFullscreen, fullscreen button falls back to onFocus
    const btn = screen.getByRole('button', { name: /fullscreen|pin focus/i });
    fireEvent.click(btn);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('pill carries the FEAT-12 drag payload (pane MIME + sessionId)', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 's1', branch: 'feat/x' })} />);
    const pill = screen.getByTestId('pane-title-pill');
    const setData = vi.fn();
    fireEvent.dragStart(pill, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(
      'application/sigmalink-pane',
      expect.stringContaining('"sessionId":"s1"'),
    );
  });

  it('header root div is NOT draggable (only the pill is)', () => {
    render(<PaneHeader {...baseProps()} />);
    const header = screen.getByTestId('pane-header');
    expect(header.getAttribute('draggable')).not.toBe('true');
  });

  it('pane-split button is disabled when canSplit=false', () => {
    render(
      <PaneHeader
        {...baseProps()}
        canSplit={false}
      />,
    );
    const split = screen.getByTestId('pane-split') as HTMLButtonElement;
    expect(split.disabled).toBe(true);
  });

  it('pane-split button is enabled when onSplit + providers + canSplit=true', () => {
    render(
      <PaneHeader
        {...baseProps()}
        onSplit={vi.fn()}
        providers={[{ id: 'claude', name: 'Claude' }]}
        canSplit={true}
      />,
    );
    const split = screen.getByTestId('pane-split') as HTMLButtonElement;
    expect(split.disabled).toBe(false);
  });

  it('pane-split is disabled when no onSplit handler supplied', () => {
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        providers={[{ id: 'claude', name: 'Claude' }]}
      />,
    );
    const split = screen.getByTestId('pane-split') as HTMLButtonElement;
    expect(split.disabled).toBe(true);
  });

  it('carries h-7 + dense variant on the toolbar strip', () => {
    const { getByTestId } = render(<PaneHeader {...baseProps()} />);
    const header = getByTestId('pane-header');
    const strip = header.querySelector('.sl-glass-toolbar') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.className).toMatch(/\bh-7\b/);
    expect(strip.className).toMatch(/\[\[data-grid-density=dense\]_&\]:h-6/);
  });

  it('gear + split + minimise are in the opacity-0 reveal wrapper (hover/focus)', () => {
    const REVEAL = /opacity-0/;
    const REVEAL_HOVER = /group-hover:opacity-100/;
    const REVEAL_FOCUS = /group-focus-within:opacity-100/;

    function revealWrapper(el: HTMLElement): HTMLElement | null {
      let node: HTMLElement | null = el;
      while (node) {
        if (REVEAL.test(node.className ?? '')) return node;
        node = node.parentElement;
      }
      return null;
    }

    render(<PaneHeader {...baseProps()} />);
    const gear = screen.getByTestId('pane-gear');
    const split = screen.getByTestId('pane-split');
    const minimise = screen.getByLabelText('Minimise pane');

    for (const el of [gear, split, minimise]) {
      const wrapper = revealWrapper(el);
      expect(wrapper).not.toBeNull();
      expect(wrapper!.className).toMatch(REVEAL_HOVER);
      expect(wrapper!.className).toMatch(REVEAL_FOCUS);
    }
  });

  it('fullscreen + close are NOT inside the opacity-0 reveal wrapper', () => {
    const REVEAL = /opacity-0/;
    function revealWrapper(el: HTMLElement): HTMLElement | null {
      let node: HTMLElement | null = el;
      while (node) {
        if (REVEAL.test(node.className ?? '')) return node;
        node = node.parentElement;
      }
      return null;
    }

    render(<PaneHeader {...baseProps()} />);
    const fullscreen = screen.getByLabelText('Fullscreen pane');
    const close = screen.getByLabelText('Close pane');
    expect(revealWrapper(fullscreen)).toBeNull();
    expect(revealWrapper(close)).toBeNull();
  });

  it('gear popover contains branch + model info from derivePaneIdentity', async () => {
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ branch: 'feat/auth', providerId: 'claude' })}
        uncommitted={2}
      />,
    );
    fireEvent.click(screen.getByTestId('pane-gear'));
    const pop = await screen.findByTestId('pane-gear-popover');
    expect(pop.textContent ?? '').toMatch(/feat\/auth/);
  });

  it('gear popover shows the brief form when session is running', async () => {
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ status: 'running' })}
      />,
    );
    fireEvent.click(screen.getByTestId('pane-gear'));
    const pop = await screen.findByTestId('pane-gear-popover');
    // Brief section or button should be present
    expect(pop.textContent ?? '').toMatch(/brief/i);
  });

  it('submitting the Brief form in the gear popover calls rpc.panes.brief', async () => {
    const { rpc } = await import('@/renderer/lib/rpc');
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ id: 'pane-1', worktreePath: '/wt/x', status: 'running' })}
      />,
    );
    fireEvent.click(screen.getByTestId('pane-gear'));
    await screen.findByTestId('pane-gear-popover');
    const goalField = screen.getByPlaceholderText(/goal/i);
    fireEvent.change(goalField, { target: { value: 'Add authentication' } });
    const submitBtn = screen.getByRole('button', { name: /inject capsule/i });
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(rpc.panes.brief).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'pane-1',
          worktreePath: '/wt/x',
          capsule: expect.objectContaining({ goal: 'Add authentication' }),
        }),
      );
    });
  });

  it('pane-rewind-item appears in gear popover for running session with worktree', async () => {
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ status: 'running', worktreePath: '/wt/path' })}
      />,
    );
    fireEvent.click(screen.getByTestId('pane-gear'));
    await screen.findByTestId('pane-gear-popover');
    expect(screen.getByTestId('pane-rewind-item')).toBeTruthy();
  });

  it('ruflo health dot is inside gear popover, not on the header bar', async () => {
    const mockHealth = useRufloDaemonHealth as ReturnType<
      typeof vi.fn<(workspaceId: string) => RufloDaemonHealth>
    >;
    mockHealth.mockReturnValue({ state: 'running', detail: 'running · port 53112' });
    render(<PaneHeader {...baseProps()} />);
    // Not on the bar
    expect(screen.queryByTestId('ruflo-health-dot')).toBeNull();
    // But inside the popover after click
    fireEvent.click(screen.getByTestId('pane-gear'));
    await screen.findByTestId('pane-gear-popover');
    expect(screen.getByTestId('pane-gear-ruflo')).toBeTruthy();
  });
});

// ── BSP-V2 — live stats badge tests ──────────────────────────────────────────

describe('PaneHeader — BSP-V2 live stats badge', () => {
  const mockStats = usePaneLiveStats as ReturnType<
    typeof vi.fn<(sessionId: string, enabled: boolean) => PaneLiveStats>
  >;

  beforeEach(() => {
    mockStats.mockClear();
  });

  it('does NOT render the badge when hasData=false (no usage yet)', () => {
    mockStats.mockReturnValue({ totalCostUsd: null, estTokPerSec: null, hasData: false });
    render(<PaneHeader {...baseProps()} />);
    expect(screen.queryByTestId('pane-live-stats-badge')).toBeNull();
  });

  it('renders the badge when hasData=true with cost and tok/s', () => {
    mockStats.mockReturnValue({
      totalCostUsd: 0.0042,
      estTokPerSec: 45.3,
      hasData: true,
    });
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge).toBeTruthy();
    // Badge must contain both the estimate (with ~) and the cost ($).
    expect(badge.textContent ?? '').toContain('~45.3 tok/s');
    expect(badge.textContent ?? '').toContain('$0.0042');
  });

  it('renders only cost when estTokPerSec is null', () => {
    mockStats.mockReturnValue({
      totalCostUsd: 0.001,
      estTokPerSec: null,
      hasData: true,
    });
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge.textContent ?? '').not.toContain('tok/s');
    expect(badge.textContent ?? '').toContain('$0.0010');
  });

  it('renders only tok/s estimate when totalCostUsd is null', () => {
    mockStats.mockReturnValue({
      totalCostUsd: null,
      estTokPerSec: 30,
      hasData: true,
    });
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge.textContent ?? '').toContain('~30 tok/s');
    expect(badge.textContent ?? '').not.toContain('$');
  });

  it('hides badge when hasData=true but both values are null', () => {
    mockStats.mockReturnValue({
      totalCostUsd: null,
      estTokPerSec: null,
      hasData: true,
    });
    render(<PaneHeader {...baseProps()} />);
    // When both are null the badge renders nothing (no parts) and returns null.
    expect(screen.queryByTestId('pane-live-stats-badge')).toBeNull();
  });

  it('badge has aria-label for accessibility', () => {
    mockStats.mockReturnValue({
      totalCostUsd: 0.005,
      estTokPerSec: 10,
      hasData: true,
    });
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge.getAttribute('aria-label')).toMatch(/live stats/i);
  });

  // ── PERF-5 status gate: PaneHeader must pass enabled = (status === 'running') ──

  it('calls usePaneLiveStats with enabled=true for a running pane', () => {
    mockStats.mockReturnValue({ totalCostUsd: null, estTokPerSec: null, hasData: false });
    render(<PaneHeader {...baseProps()} session={makeSession({ status: 'running' })} />);
    expect(mockStats).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('calls usePaneLiveStats with enabled=false for an exited pane (no poll-storm)', () => {
    mockStats.mockReturnValue({ totalCostUsd: null, estTokPerSec: null, hasData: false });
    render(<PaneHeader {...baseProps()} session={makeSession({ status: 'exited' })} />);
    expect(mockStats).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('calls usePaneLiveStats with enabled=false for an error pane', () => {
    mockStats.mockReturnValue({ totalCostUsd: null, estTokPerSec: null, hasData: false });
    render(<PaneHeader {...baseProps()} session={makeSession({ status: 'error' })} />);
    expect(mockStats).toHaveBeenCalledWith(expect.any(String), false);
  });
});
