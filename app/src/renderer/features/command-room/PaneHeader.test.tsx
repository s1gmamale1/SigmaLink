// @vitest-environment jsdom
//
// Phase 4 Lane A — PaneHeader unit coverage. Validates the BridgeSpace-faithful
// pane header: title pill (drag handle, status glyph, alias·effort) + icon
// cluster (gear, fullscreen, split, minimise, close). All metadata is relocated
// to the gear popover (PaneGearPopoverBody).
//
// BSP-V2 — also covers the live cost + tok/s estimate badge.

import { describe, expect, it, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: {
      brief: vi.fn().mockResolvedValue(undefined),
      setDisplayProvider: vi.fn().mockResolvedValue({ ok: true }),
      rename: vi.fn().mockResolvedValue({ ok: true }),
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
    paneTitle: { summarize: vi.fn().mockResolvedValue({ title: null }) },
  },
  // CheckpointPanel + PaneHeader BSP-O4 use onEvent for event subscriptions.
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

  it('carries h-7 on the toolbar strip', () => {
    const { getByTestId } = render(<PaneHeader {...baseProps()} />);
    const header = getByTestId('pane-header');
    const strip = header.querySelector('.sl-glass-toolbar') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.className).toMatch(/\bh-7\b/);
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
  const liveStats = (input: Partial<PaneLiveStats>): PaneLiveStats => ({
    totalCostUsd: null,
    estTokPerSec: null,
    rssBytes: null,
    processCount: null,
    rootRssBytes: null,
    mcpRssBytes: null,
    topChildCommand: null,
    hasData: false,
    ...input,
  });

  beforeEach(() => {
    mockStats.mockClear();
  });

  it('does NOT render the badge when hasData=false (no usage yet)', () => {
    mockStats.mockReturnValue(liveStats({ hasData: false }));
    render(<PaneHeader {...baseProps()} />);
    expect(screen.queryByTestId('pane-live-stats-badge')).toBeNull();
  });

  it('renders the badge when hasData=true with cost and tok/s', () => {
    mockStats.mockReturnValue(liveStats({
      totalCostUsd: 0.0042,
      estTokPerSec: 45.3,
      hasData: true,
    }));
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge).toBeTruthy();
    // Badge must contain both the estimate (with ~) and the cost ($).
    expect(badge.textContent ?? '').toContain('~45.3 tok/s');
    expect(badge.textContent ?? '').toContain('$0.0042');
  });

  it('renders only cost when estTokPerSec is null', () => {
    mockStats.mockReturnValue(liveStats({
      totalCostUsd: 0.001,
      estTokPerSec: null,
      hasData: true,
    }));
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge.textContent ?? '').not.toContain('tok/s');
    expect(badge.textContent ?? '').toContain('$0.0010');
  });

  it('renders only tok/s estimate when totalCostUsd is null', () => {
    mockStats.mockReturnValue(liveStats({
      totalCostUsd: null,
      estTokPerSec: 30,
      hasData: true,
    }));
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge.textContent ?? '').toContain('~30 tok/s');
    expect(badge.textContent ?? '').not.toContain('$');
  });

  it('hides badge when hasData=true but both values are null', () => {
    mockStats.mockReturnValue(liveStats({
      totalCostUsd: null,
      estTokPerSec: null,
      hasData: true,
    }));
    render(<PaneHeader {...baseProps()} />);
    // When both are null the badge renders nothing (no parts) and returns null.
    expect(screen.queryByTestId('pane-live-stats-badge')).toBeNull();
  });

  it('badge has aria-label for accessibility', () => {
    mockStats.mockReturnValue(liveStats({
      totalCostUsd: 0.005,
      estTokPerSec: 10,
      hasData: true,
    }));
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-live-stats-badge');
    expect(badge.getAttribute('aria-label')).toMatch(/live stats/i);
  });

  // ── PERF-5 status gate: PaneHeader must pass enabled = (status === 'running') ──

  it('calls usePaneLiveStats with enabled=true for a running pane', () => {
    mockStats.mockReturnValue(liveStats({ hasData: false }));
    render(<PaneHeader {...baseProps()} session={makeSession({ status: 'running' })} />);
    expect(mockStats).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('calls usePaneLiveStats with enabled=false for an exited pane (no poll-storm)', () => {
    mockStats.mockReturnValue(liveStats({ hasData: false }));
    render(<PaneHeader {...baseProps()} session={makeSession({ status: 'exited' })} />);
    expect(mockStats).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('calls usePaneLiveStats with enabled=false for an error pane', () => {
    mockStats.mockReturnValue(liveStats({ hasData: false }));
    render(<PaneHeader {...baseProps()} session={makeSession({ status: 'error' })} />);
    expect(mockStats).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('renders RSS badge detail with root and MCP memory breakdown', () => {
    mockStats.mockReturnValue(liveStats({
      hasData: false,
      rssBytes: 800 * 1024 * 1024,
      rootRssBytes: 500 * 1024 * 1024,
      mcpRssBytes: 300 * 1024 * 1024,
      processCount: 2,
      topChildCommand: 'node',
    }));
    render(<PaneHeader {...baseProps()} />);
    const badge = screen.getByTestId('pane-rss-badge');
    expect(badge.textContent ?? '').toContain('RSS 800 MB');
    expect(badge.getAttribute('title')).toContain('root 500 MB');
    expect(badge.getAttribute('title')).toContain('MCP 300 MB');
    expect(badge.getAttribute('title')).toContain('top child node');
  });
});

// ── BSP-O4 — inline rename tests ─────────────────────────────────────────────

describe('PaneHeader — BSP-O4 inline rename', () => {
  it('shows session.name when set, falling back to alias when null', () => {
    // session.name set → custom name shown
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ name: 'My custom pane' })}
      />,
    );
    const pill = screen.getByTestId('pane-display-name');
    expect(pill.textContent ?? '').toContain('My custom pane');
    cleanup();

    // session.name null → alias shown (deterministic from session.id)
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ name: null })}
      />,
    );
    const pillFallback = screen.getByTestId('pane-display-name');
    // alias is not "My custom pane" and is non-empty
    expect(pillFallback.textContent ?? '').not.toContain('My custom pane');
    expect(pillFallback.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('entering edit mode on double-click shows the rename input', async () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ name: 'Original' })} />);
    const nameSpan = screen.getByTestId('pane-display-name');
    fireEvent.doubleClick(nameSpan);
    await waitFor(() => expect(screen.getByTestId('pane-rename-input')).toBeTruthy());
    const input = screen.getByTestId('pane-rename-input') as HTMLInputElement;
    // The input should be pre-filled with the current name.
    expect(input.value).toBe('Original');
  });

  it('pressing Enter commits the rename and calls rpc.panes.rename', async () => {
    const { rpc: mockRpc } = await import('@/renderer/lib/rpc');
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ id: 'sess-rename', name: 'Old' })}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('pane-display-name'));
    await waitFor(() => expect(screen.getByTestId('pane-rename-input')).toBeTruthy());
    const input = screen.getByTestId('pane-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(mockRpc.panes.rename).toHaveBeenCalledWith({
        sessionId: 'sess-rename',
        name: 'New name',
      }),
    );
  });

  it('pressing Escape cancels the rename without calling rpc.panes.rename', async () => {
    const { rpc: mockRpc } = await import('@/renderer/lib/rpc');
    (mockRpc.panes.rename as ReturnType<typeof vi.fn>).mockClear();
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ name: 'Keep me' })}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('pane-display-name'));
    await waitFor(() => expect(screen.getByTestId('pane-rename-input')).toBeTruthy());
    const input = screen.getByTestId('pane-rename-input');
    fireEvent.change(input, { target: { value: 'Discard this' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pane-rename-input')).toBeNull());
    expect(mockRpc.panes.rename).not.toHaveBeenCalled();
    // The display name should revert to the original.
    expect(screen.getByTestId('pane-display-name').textContent ?? '').toContain('Keep me');
  });

  it('blurring the input commits the rename', async () => {
    const { rpc: mockRpc } = await import('@/renderer/lib/rpc');
    render(
      <PaneHeader
        {...baseProps()}
        session={makeSession({ id: 'sess-blur', name: null })}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('pane-display-name'));
    await waitFor(() => expect(screen.getByTestId('pane-rename-input')).toBeTruthy());
    const input = screen.getByTestId('pane-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Blur name' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(mockRpc.panes.rename).toHaveBeenCalledWith({
        sessionId: 'sess-blur',
        name: 'Blur name',
      }),
    );
  });
});

// ── Auto-label precedence tests ───────────────────────────────────────────────

import { setAgentLabel, __resetAgentLabels } from '@/renderer/lib/pane-labels';
import { feedPromptKey, __resetPromptCapture } from '@/renderer/lib/pane-prompt-capture';
import { onAgentLabel, __resetPaneTitleOrchestrator } from '@/renderer/lib/pane-title-orchestrator';

/** Type a prompt into a pane's capture and submit it (feeds the shared label). */
function typePrompt(sessionId: string, text: string): void {
  const base = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
  for (const ch of text) feedPromptKey(sessionId, { key: ch, ...base });
  feedPromptKey(sessionId, { key: 'Enter', ...base });
}

describe('PaneHeader name + task label (separate slots)', () => {
  afterEach(() => { __resetAgentLabels(); __resetPromptCapture(); __resetPaneTitleOrchestrator(); });

  // ── NAME (stable identity, the rename target) ──
  it('name shows the alias when there is no manual name', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'p1', name: null, initialPrompt: undefined })} />);
    expect(screen.getByTestId('pane-display-name').textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('name shows the operator rename over the alias', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'p1b', name: 'My pane' })} />);
    expect(screen.getByTestId('pane-display-name').textContent).toContain('My pane');
  });

  it('a SIGMA::LABEL does NOT change the name — name and label are separate slots', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'p1c', name: 'Reviewer' })} />);
    act(() => setAgentLabel('p1c', 'Reviewing PR'));
    expect(screen.getByTestId('pane-display-name').textContent).toContain('Reviewer');
    expect(screen.getByTestId('pane-display-name').textContent).not.toContain('Reviewing PR');
    // …but the label DOES show, in its own slot.
    expect(screen.getByTestId('pane-task-label').textContent).toContain('Reviewing PR');
  });

  // ── LABEL (live task, separate slot) ──
  it('label is empty for an idle pane (no SIGMA::LABEL, no prompt, no launch task)', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l0', name: null, initialPrompt: undefined })} />);
    expect((screen.getByTestId('pane-task-label').textContent ?? '').trim()).toBe('');
  });

  it('a typed prompt shows an instant heuristic title (not the raw ramble, no titling…)', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l1', name: null, initialPrompt: undefined })} />);
    const raw = 'build a robust ecommerce website with cart and checkout flows';
    act(() => typePrompt('l1', raw));
    const label = screen.getByTestId('pane-task-label');
    expect((label.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(label.textContent).not.toContain('titling');
    expect(label.textContent).not.toBe(raw); // not the raw long prompt
  });

  it('a SIGMA::LABEL upgrades the heuristic to the clean agent title', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l2', name: null, initialPrompt: undefined })} />);
    act(() => typePrompt('l2', 'some long raw prompt the operator typed here'));
    act(() => onAgentLabel('l2', 'Refactor Tokens'));
    expect(screen.getByTestId('pane-task-label').textContent).toContain('Refactor Tokens');
  });

  it('label shows Claude SIGMA::LABEL', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l3', name: null })} />);
    act(() => setAgentLabel('l3', 'Refactor tokens'));
    expect(screen.getByTestId('pane-task-label').textContent).toContain('Refactor tokens');
  });

  it('label falls back to the launch-prompt summary when no SIGMA::LABEL/prompt', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l4', name: null, initialPrompt: 'Refactor the auth module' })} />);
    expect(screen.getByTestId('pane-task-label').textContent).toContain('Refactor the auth module');
  });

  it('label is not floored at 80px (full task can grow); truncate + min-w-0 + title stay', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l5', name: null })} />);
    const full = 'Async token refresh refactor across the gateway';
    act(() => setAgentLabel('l5', full));
    const label = screen.getByTestId('pane-task-label');
    expect(label.textContent ?? '').toContain(full);
    expect(label.className).not.toContain('max-w-[80px]');
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
    expect(label.getAttribute('title')).toContain('Async token refresh');
  });

  it('title pill is min-w-0 (not shrink-0) so the name ellipsizes before badges are pushed off', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'l6', name: null })} />);
    const pill = screen.getByTestId('pane-title-pill');
    expect(pill.className).toContain('min-w-0');
    expect(pill.className).not.toContain('shrink-0');
  });

  // ── rename targets the NAME, not the label ──
  it('opens inline edit on a targeted pane-rename-request', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'r1', name: null })} />);
    act(() => window.dispatchEvent(new CustomEvent('sigma:pane-rename-request', { detail: { sessionId: 'r1' } })));
    expect(screen.getByTestId('pane-rename-input')).toBeTruthy();
  });

  it('rename prefills the NAME (alias), NOT the live task label', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'r2', name: null, initialPrompt: 'Old prompt' })} />);
    act(() => setAgentLabel('r2', 'Reviewing PR'));
    act(() => window.dispatchEvent(new CustomEvent('sigma:pane-rename-request', { detail: { sessionId: 'r2' } })));
    const input = screen.getByTestId('pane-rename-input') as HTMLInputElement;
    expect(input.value).not.toBe('Reviewing PR'); // not the task label
    expect(input.value.length).toBeGreaterThan(0); // the alias
  });
});

// ── Task 5 — visible rename affordance ───────────────────────────────────────

describe('PaneHeader rename affordance', () => {
  it('shows a rename button that opens inline edit', () => {
    render(<PaneHeader {...baseProps()} session={makeSession({ id: 'aff1', name: null })} />);
    const btn = screen.getByTestId('pane-rename-affordance');
    fireEvent.click(btn);
    expect(screen.getByTestId('pane-rename-input')).toBeTruthy();
  });
});
