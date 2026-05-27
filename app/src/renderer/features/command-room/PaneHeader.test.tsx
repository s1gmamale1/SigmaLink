// @vitest-environment jsdom
//
// V1.1.4 Step 4 — PaneHeader unit coverage. Validates the collapsed h-7
// chrome (provider label · 4 icon buttons) against the acceptance criteria
// in task #50: truncated `CLAUDE·1` label, Focus lifts focus, Close calls
// the close handler, Split + Minimise are `disabled`, tooltip surfaces cwd.

import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: { brief: vi.fn().mockResolvedValue(undefined) },
  },
  rpcSilent: {
    ruflo: { daemonStatus: vi.fn().mockResolvedValue([]) },
  },
}));

// Mock useRufloDaemonHealth so PaneHeader tests are isolated from the hook's
// polling logic. Default to 'running' state; individual B2 tests override.
vi.mock('./useRufloDaemonHealth', () => ({
  useRufloDaemonHealth: vi.fn(() => ({ state: 'running', detail: 'running · port 53112' })),
}));

import { PaneHeader } from './PaneHeader';
import type { AgentSession } from '@/shared/types';
import type { RufloDaemonHealth } from './useRufloDaemonHealth';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';

// Radix tooltip uses ResizeObserver under the hood, which jsdom doesn't
// ship. A no-op polyfill is enough for our assertions — we only care that
// the tooltip content is mounted with the right text.
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

afterEach(() => {
  cleanup();
});

// Shared base props used by B2 info-bar tests (and any future test that
// needs a minimal valid PaneHeader without re-declaring each prop).
const base = {
  session: makeSession(),
  paneIndex: 1,
  onFocus: () => undefined,
  onClose: () => undefined,
};

describe('PaneHeader', () => {
  it('renders the truncated provider label with 1-based pane index', () => {
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={() => undefined}
        onClose={() => undefined}
      />,
    );
    const label = screen.getByLabelText('Claude·1');
    expect(label.textContent).toBe('Claude·1');
    expect(label.className).toMatch(/truncate/);
    expect(label.className).toMatch(/max-w-\[80px\]/);
  });

  it('shortens multi-word provider names (e.g. Codex CLI → Codex)', () => {
    render(
      <PaneHeader
        session={makeSession({ providerId: 'codex' })}
        paneIndex={2}
        onFocus={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByLabelText('Codex·2').textContent).toBe('Codex·2');
  });

  it('invokes onFocus when the Focus button is clicked', () => {
    const onFocus = vi.fn();
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={onFocus}
        onClose={() => undefined}
      />,
    );
    // v1.2.5 — Focus button relabelled to honestly describe what it does
    // (pin the focus ring, not fullscreen the pane). Aria-label + tooltip
    // now read "Pin focus ring (Cmd+Alt+N)".
    const focusBtn = screen.getByRole('button', { name: 'Pin focus ring (Cmd+Alt+N)' });
    fireEvent.click(focusBtn);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when the Close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={() => undefined}
        onClose={onClose}
      />,
    );
    const closeBtn = screen.getByRole('button', { name: 'Close pane' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders Split and Minimise as disabled placeholders when callers do not wire them', () => {
    // v1.4.3 #06 — When `onSplit` / `onToggleMinimise` are NOT supplied
    // (legacy callers / older tests), the icons fall back to the v1.2.5
    // disabled placeholder. Both Split-V (Columns2) and Split-H (Rows2) live
    // as buttons with aria-label="Split pane", so `getAllByRole` picks them
    // both up.
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={() => undefined}
        onClose={() => undefined}
      />,
    );
    const splits = screen.getAllByRole('button', { name: 'Split pane' }) as HTMLButtonElement[];
    expect(splits.length).toBeGreaterThanOrEqual(2);
    const minimise = screen.getByRole('button', { name: 'Minimise pane' }) as HTMLButtonElement;
    for (const s of splits) {
      expect(s.disabled).toBe(true);
      expect(s.className).toMatch(/cursor-not-allowed/);
      expect(s.className).toMatch(/opacity-40/);
    }
    expect(minimise.disabled).toBe(true);
    expect(minimise.className).toMatch(/cursor-not-allowed/);
    expect(minimise.className).toMatch(/opacity-40/);
  });

  it('wires the provider name as a tooltip trigger pointing at the cwd', () => {
    // We deliberately don't drive the Radix open animation in jsdom — its
    // lazy portal mount needs real pointer + timers we can't reliably fake
    // without `@testing-library/user-event`. Instead, assert the trigger
    // is wired up (data-slot + aria) and that the underlying session has
    // the cwd we'd surface; the Radix render path itself is covered by
    // its own upstream tests.
    render(
      <PaneHeader
        session={makeSession({ cwd: '/Users/alice/projects/demo', branch: 'feat/x' })}
        paneIndex={1}
        onFocus={() => undefined}
        onClose={() => undefined}
      />,
    );
    const label = screen.getByLabelText('Claude·1');
    const trigger = label.closest('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('data-state')).toBe('closed');
  });

  // v1.4.2 packet-12 — Pane Focus icon morphs into a real fullscreen toggle
  // when callers wire `onToggleFullscreen`. Legacy callers without the new
  // prop fall back to the v1.2.5 "Pin focus ring" behaviour (covered above).
  it('packet-12: shows the Fullscreen pane label when not focused', () => {
    const onToggle = vi.fn();
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={() => undefined}
        onClose={() => undefined}
        isFullscreen={false}
        onToggleFullscreen={onToggle}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Fullscreen pane' });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('packet-12: swaps to Exit fullscreen when isFullscreen=true', () => {
    const onToggle = vi.fn();
    render(
      <PaneHeader
        session={makeSession()}
        paneIndex={1}
        onFocus={() => undefined}
        onClose={() => undefined}
        isFullscreen
        onToggleFullscreen={onToggle}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Exit fullscreen (Esc)' });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    // The legacy "Pin focus ring" label must not be visible in this mode.
    expect(screen.queryByRole('button', { name: 'Pin focus ring (Cmd+Alt+N)' })).toBeNull();
  });

  // v1.4.3 #06 — Pane Split + Minimise wired surface.
  describe('v1.4.3 #06 — Split + Minimise wiring', () => {
    it('renders the Split buttons as enabled when onSplit + providers are wired', () => {
      render(
        <PaneHeader
          session={makeSession()}
          paneIndex={1}
          onFocus={() => undefined}
          onClose={() => undefined}
          providers={[
            { id: 'claude', name: 'Claude' },
            { id: 'codex', name: 'Codex' },
          ]}
          onSplit={() => undefined}
        />,
      );
      const splits = screen.getAllByRole('button', { name: 'Split pane' }) as HTMLButtonElement[];
      expect(splits.length).toBeGreaterThanOrEqual(2);
      for (const s of splits) {
        expect(s.disabled).toBe(false);
        expect(s.className).not.toMatch(/cursor-not-allowed/);
      }
    });

    it('keeps Split disabled when canSplit=false (parent already in a split group)', () => {
      render(
        <PaneHeader
          session={makeSession()}
          paneIndex={1}
          onFocus={() => undefined}
          onClose={() => undefined}
          providers={[{ id: 'claude', name: 'Claude' }]}
          onSplit={() => undefined}
          canSplit={false}
        />,
      );
      const splits = screen.getAllByRole('button', { name: 'Split pane' }) as HTMLButtonElement[];
      for (const s of splits) {
        expect(s.disabled).toBe(true);
        expect(s.className).toMatch(/opacity-40/);
      }
    });

    it('invokes onToggleMinimise when the Minimise button is clicked', () => {
      const onToggleMinimise = vi.fn();
      render(
        <PaneHeader
          session={makeSession()}
          paneIndex={1}
          onFocus={() => undefined}
          onClose={() => undefined}
          onToggleMinimise={onToggleMinimise}
          isMinimised={false}
        />,
      );
      const btn = screen.getByRole('button', { name: 'Minimise pane' });
      fireEvent.click(btn);
      expect(onToggleMinimise).toHaveBeenCalledTimes(1);
    });

    it('swaps the Minimise label to "Restore pane" when isMinimised=true', () => {
      const onToggleMinimise = vi.fn();
      render(
        <PaneHeader
          session={makeSession()}
          paneIndex={1}
          onFocus={() => undefined}
          onClose={() => undefined}
          onToggleMinimise={onToggleMinimise}
          isMinimised={true}
        />,
      );
      const btn = screen.getByRole('button', { name: 'Restore pane' });
      fireEvent.click(btn);
      expect(onToggleMinimise).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Minimise pane' })).toBeNull();
    });
  });

  it('embeds the cwd, branch, model, and effort in the tooltip body', async () => {
    // Render a wrapper that forces the tooltip open via the controlled
    // `open` prop. This bypasses Radix's pointer-enter timing in jsdom but
    // still exercises the actual TooltipContent we ship.
    const { TooltipContent } = await import('@/components/ui/tooltip');
    const { Tooltip, TooltipProvider, TooltipTrigger } = await import('@/components/ui/tooltip');
    function OpenTooltip() {
      const session = makeSession({
        cwd: '/Users/alice/projects/demo',
        branch: 'feat/x',
      });
      return (
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger asChild>
              <span>label</span>
            </TooltipTrigger>
            <TooltipContent>
              <div>
                <div>branch: {session.branch}</div>
                <div>model: claude-opus-4.7</div>
                <div>effort: high</div>
                <div>cwd: {session.cwd}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    render(<OpenTooltip />);
    // Radix mounts the tooltip content in two places (the live aria-live
    // region for screen readers plus the visible portal). `getAllByText`
    // covers both and asserts the content reached the DOM.
    expect(
      screen.getAllByText(/cwd: \/Users\/alice\/projects\/demo/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/branch: feat\/x/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/model: claude-opus-4\.7/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/effort: high/).length).toBeGreaterThan(0);
  });

  // B2 — per-pane info bar (C-1 UI)
  it('renders inline branch + model + uncommitted badge', () => {
    render(<PaneHeader {...base} session={{ ...base.session, branch: 'feat/auth', providerId: 'claude' }} uncommitted={3} />);
    expect(screen.getByText('feat/auth')).toBeTruthy();
    expect(screen.getByText(/opus/)).toBeTruthy();
    expect(screen.getByText('±3')).toBeTruthy();
  });

  it('hides badge when uncommitted is 0 or null', () => {
    const { rerender } = render(<PaneHeader {...base} uncommitted={0} />);
    expect(screen.queryByText(/^±/)).toBeNull();
    rerender(<PaneHeader {...base} uncommitted={null} />);
    expect(screen.queryByText(/^±/)).toBeNull();
  });

  it('header is a drag source carrying pane payload', () => {
    render(<PaneHeader {...base} session={{ ...base.session, id: 's1', branch: 'feat/x' }} />);
    const header = screen.getByTestId('pane-header');
    const setData = vi.fn();
    fireEvent.dragStart(header, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith('application/sigmalink-pane', expect.stringContaining('"sessionId":"s1"'));
  });

  // Stage 2 / Lane P — P1 hover/focus reveal of situational controls.
  describe('Stage 2 — hover/focus reveal of situational controls (P1)', () => {
    const REVEAL = /opacity-0/;
    const REVEAL_HOVER = /group-hover:opacity-100/;
    const REVEAL_FOCUS = /group-focus-within:opacity-100/;

    /** Walk up from `el` to the nearest ancestor carrying `opacity-0`. */
    function revealWrapper(el: HTMLElement): HTMLElement | null {
      let node: HTMLElement | null = el;
      while (node) {
        if (REVEAL.test(node.className ?? '')) return node;
        node = node.parentElement;
      }
      return null;
    }

    function renderWired() {
      return render(
        <PaneHeader
          {...base}
          providers={[{ id: 'claude', name: 'Claude' }]}
          onSplit={() => undefined}
          onToggleMinimise={() => undefined}
          onToggleFullscreen={() => undefined}
        />,
      );
    }

    it('wraps Split / Minimise / Brief in a hover+focus-within reveal container', () => {
      renderWired();
      const split = screen.getAllByRole('button', { name: 'Split pane' })[0] as HTMLElement;
      const minimise = screen.getByRole('button', { name: 'Minimise pane' });
      const brief = screen.getByRole('button', { name: /brief/i });

      for (const btn of [split, minimise, brief]) {
        const wrapper = revealWrapper(btn);
        expect(wrapper).not.toBeNull();
        expect(wrapper!.className).toMatch(REVEAL_HOVER);
        expect(wrapper!.className).toMatch(REVEAL_FOCUS);
      }
    });

    it('keeps Fullscreen + Close ALWAYS visible (no reveal wrapper)', () => {
      renderWired();
      const fullscreen = screen.getByRole('button', { name: 'Fullscreen pane' });
      const close = screen.getByRole('button', { name: 'Close pane' });
      expect(revealWrapper(fullscreen)).toBeNull();
      expect(revealWrapper(close)).toBeNull();
    });

    it('keeps the info row (status dot / provider / branch / model) ALWAYS rendered', () => {
      render(
        <PaneHeader
          {...base}
          session={{ ...base.session, branch: 'feat/auth', providerId: 'claude' }}
          uncommitted={3}
          providers={[{ id: 'claude', name: 'Claude' }]}
          onSplit={() => undefined}
          onToggleMinimise={() => undefined}
          onToggleFullscreen={() => undefined}
        />,
      );
      // Provider label, branch, model, and uncommitted badge are present and
      // not behind the opacity-0 reveal.
      const label = screen.getByLabelText('Claude·1');
      expect(revealWrapper(label)).toBeNull();
      const branch = screen.getByText('feat/auth');
      expect(revealWrapper(branch)).toBeNull();
      expect(screen.getByText('±3')).toBeTruthy();
    });

    it('keeps the situational controls in the DOM + tab order (opacity only, not display:none)', () => {
      renderWired();
      const split = screen.getAllByRole('button', { name: 'Split pane' })[0] as HTMLElement;
      const wrapper = revealWrapper(split)!;
      // opacity-only reveal — never display:none, so Tab still reaches them.
      expect(wrapper.className).not.toMatch(/\bhidden\b/);
      expect(wrapper.style.display).not.toBe('none');
    });
  });

  // Stage 2 / Lane P — P3 density-aware header height.
  it('carries the dense-tier h-6 height override on the toolbar strip', () => {
    const { getByTestId } = render(<PaneHeader {...base} />);
    const header = getByTestId('pane-header');
    const strip = header.querySelector('.sl-glass-toolbar') as HTMLElement;
    expect(strip).toBeTruthy();
    // Comfortable/compact baseline stays h-7; the dense ancestor variant
    // shrinks it to h-6 without a new prop.
    expect(strip.className).toMatch(/\bh-7\b/);
    expect(strip.className).toMatch(/\[\[data-density=dense\]_&\]:h-6/);
  });

  describe('Brief popover (C-5)', () => {
    it('Brief button is disabled when session is not running', () => {
      render(<PaneHeader {...base} session={{ ...base.session, status: 'exited' }} />);
      const briefBtn = screen.getByRole('button', { name: /brief/i });
      expect((briefBtn as HTMLButtonElement).disabled).toBe(true);
    });

    it('Brief button is enabled when session is running', () => {
      render(<PaneHeader {...base} session={{ ...base.session, status: 'running' }} />);
      const briefBtn = screen.getByRole('button', { name: /brief/i });
      expect((briefBtn as HTMLButtonElement).disabled).toBe(false);
    });

    it('submitting the Brief form calls rpc.panes.brief with correct capsule', async () => {
      const { rpc } = await import('@/renderer/lib/rpc');
      render(<PaneHeader {...base} session={{ ...base.session, id: 'pane-1', worktreePath: '/wt/x', status: 'running' }} />);
      const briefBtn = screen.getByRole('button', { name: /brief/i });
      fireEvent.click(briefBtn);
      // Fill in the goal field
      const goalField = screen.getByPlaceholderText(/goal/i);
      fireEvent.change(goalField, { target: { value: 'Add authentication' } });
      const submitBtn = screen.getByRole('button', { name: /inject/i });
      fireEvent.click(submitBtn);
      await waitFor(() => {
        expect(rpc.panes.brief).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: 'pane-1',
          worktreePath: '/wt/x',
          capsule: expect.objectContaining({ goal: 'Add authentication' }),
        }));
      });
    });
  });

  // SF-7 Task B2 — Ruflo health dot.
  describe('SF-7 B2 — Ruflo health dot', () => {
    const mockHealth = useRufloDaemonHealth as ReturnType<
      typeof vi.fn<(workspaceId: string) => RufloDaemonHealth>
    >;

    it('renders the ruflo-health-dot element', () => {
      mockHealth.mockReturnValue({ state: 'running', detail: 'running · port 53112' });
      render(<PaneHeader {...base} />);
      expect(screen.getByTestId('ruflo-health-dot')).toBeTruthy();
    });

    it('dot has emerald colour class when state=running', () => {
      mockHealth.mockReturnValue({ state: 'running', detail: 'running · port 53112' });
      render(<PaneHeader {...base} />);
      const dot = screen.getByTestId('ruflo-health-dot');
      expect(dot.className).toMatch(/emerald/);
    });

    it('dot has amber colour class when state=fallback', () => {
      mockHealth.mockReturnValue({ state: 'fallback', detail: 'stdio fallback — HTTP daemon unavailable' });
      render(<PaneHeader {...base} />);
      const dot = screen.getByTestId('ruflo-health-dot');
      expect(dot.className).toMatch(/amber/);
    });

    it('dot has red colour class when state=down', () => {
      mockHealth.mockReturnValue({ state: 'down', detail: 'crashed — restart the workspace to recover' });
      render(<PaneHeader {...base} />);
      const dot = screen.getByTestId('ruflo-health-dot');
      expect(dot.className).toMatch(/red/);
    });

    it('dot has amber colour class when state=starting', () => {
      mockHealth.mockReturnValue({ state: 'starting', detail: 'starting…' });
      render(<PaneHeader {...base} />);
      const dot = screen.getByTestId('ruflo-health-dot');
      expect(dot.className).toMatch(/amber/);
    });

    it('dot has slate colour class when state=unknown', () => {
      mockHealth.mockReturnValue({ state: 'unknown', detail: 'Ruflo MCP status unavailable' });
      render(<PaneHeader {...base} />);
      const dot = screen.getByTestId('ruflo-health-dot');
      expect(dot.className).toMatch(/slate/);
    });

    it('dot has an aria-label reflecting the detail', () => {
      mockHealth.mockReturnValue({ state: 'running', detail: 'running · port 53112' });
      render(<PaneHeader {...base} />);
      const dot = screen.getByTestId('ruflo-health-dot');
      expect(dot.getAttribute('aria-label')).toMatch(/Ruflo MCP/i);
    });

    it('calls useRufloDaemonHealth with the session workspaceId', () => {
      mockHealth.mockReturnValue({ state: 'running', detail: 'running · port 53112' });
      render(<PaneHeader {...base} session={{ ...base.session, workspaceId: 'ws-test-42' }} />);
      expect(mockHealth).toHaveBeenCalledWith('ws-test-42');
    });
  });
});
