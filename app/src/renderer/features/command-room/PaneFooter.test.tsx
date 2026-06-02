// @vitest-environment jsdom
//
// ANIM-3 — PaneFooter aliveness segment unit tests.
//
// Covers:
//  1. Running session renders a progress verb + elapsed string.
//  2. Elapsed updates after 1 second.
//  3. After 4 seconds the verb advances (reduced-motion OFF).
//  4. With prefersReducedMotion() === true the verb does NOT change across ticks.
//  5. Exited session renders null (no DOM output).
//  6. FEAT-12: drop-zone accepts PANE_DRAG_MIME → buildPaneContext + insertMention.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import type { AgentSession } from '@/shared/types';

// Mock rpcSilent.kv.get so the existing kvKey effect resolves immediately
// without triggering real IPC — keeps all tests isolated.
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
    },
  },
}));

// motion mock — default is reduced-motion OFF; individual tests override.
vi.mock('@/renderer/lib/motion', () => ({
  prefersReducedMotion: vi.fn(() => false),
}));

// FEAT-12 — mock pane-context-builder + insertMention so the drop-handler
// tests don't trigger real IPC.
vi.mock('@/renderer/lib/pane-context-builder', () => ({
  PANE_DRAG_MIME: 'application/sigmalink-pane',
  buildPaneContext: vi.fn().mockResolvedValue('--- Pane context ---\nbranch: main\n--- end pane context ---'),
}));

vi.mock('./insertMention', () => ({
  insertMention: vi.fn().mockResolvedValue(undefined),
}));

import { PaneFooter } from './PaneFooter';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import { PROGRESS_VERBS } from './progress-verbs';
import { buildPaneContext } from '@/renderer/lib/pane-context-builder';
import { insertMention } from './insertMention';

const mockPrefersReducedMotion = prefersReducedMotion as ReturnType<typeof vi.fn>;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/code',
    branch: null,
    status: 'running',
    startedAt: Date.now(),
    worktreePath: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPrefersReducedMotion.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('PaneFooter — ANIM-3 aliveness segment', () => {
  it('renders a progress verb and elapsed string for a running session', () => {
    const session = makeSession({ startedAt: Date.now() });
    render(<PaneFooter session={session} />);

    const aliveness = screen.getByTestId('pane-aliveness');
    expect(aliveness).toBeTruthy();

    // The text contains one of the known progress verbs.
    const text = aliveness.textContent ?? '';
    const hasVerb = PROGRESS_VERBS.some((v) => text.includes(v));
    expect(hasVerb).toBe(true);

    // Initial elapsed should be "0s" (session just started, timers frozen).
    expect(text).toMatch(/0s/);
  });

  it('shows the hint text on the right alongside the aliveness segment', () => {
    render(<PaneFooter session={makeSession()} />);
    expect(screen.getByText(/auto mode on/)).toBeTruthy();
    expect(screen.getByTestId('pane-aliveness')).toBeTruthy();
  });

  it('elapsed updates to 1s after advancing timers by 1 second', () => {
    const session = makeSession({ startedAt: Date.now() });
    render(<PaneFooter session={session} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const text = screen.getByTestId('pane-aliveness').textContent ?? '';
    expect(text).toMatch(/1s/);
  });

  it('elapsed shows m:ss format after 90 seconds', () => {
    const session = makeSession({ startedAt: Date.now() });
    render(<PaneFooter session={session} />);

    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    const text = screen.getByTestId('pane-aliveness').textContent ?? '';
    expect(text).toMatch(/1:30/);
  });

  it('verb advances after ~4 ticks when reduced-motion is OFF', () => {
    mockPrefersReducedMotion.mockReturnValue(false);
    const session = makeSession({ startedAt: Date.now() });
    render(<PaneFooter session={session} />);

    const textBefore = screen.getByTestId('pane-aliveness').textContent ?? '';
    const verbBefore = PROGRESS_VERBS.find((v) => textBefore.includes(v));
    expect(verbBefore).toBeDefined();

    // Advance 4 ticks — the verb should have rotated.
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    const textAfter = screen.getByTestId('pane-aliveness').textContent ?? '';
    const verbAfter = PROGRESS_VERBS.find((v) => textAfter.includes(v));
    expect(verbAfter).toBeDefined();

    // After 4 ticks, verbIndex has incremented once, so the displayed verb differs.
    expect(verbAfter).not.toBe(verbBefore);
  });

  it('verb does NOT change across ticks when prefersReducedMotion() is true', () => {
    mockPrefersReducedMotion.mockReturnValue(true);
    const session = makeSession({ startedAt: Date.now() });
    render(<PaneFooter session={session} />);

    const textBefore = screen.getByTestId('pane-aliveness').textContent ?? '';
    const verbBefore = PROGRESS_VERBS.find((v) => textBefore.includes(v));

    // Advance many ticks — rotation is gated, so verb stays frozen.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    const textAfter = screen.getByTestId('pane-aliveness').textContent ?? '';
    const verbAfter = PROGRESS_VERBS.find((v) => textAfter.includes(v));

    // Verb unchanged.
    expect(verbAfter).toBe(verbBefore);
    // But elapsed DID tick — it should NOT still be "0s".
    expect(textAfter).not.toMatch(/\b0s\b/);
  });

  it('renders null for an exited session (no DOM output)', () => {
    const { container } = render(
      <PaneFooter session={makeSession({ status: 'exited' })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders null for an error session', () => {
    const { container } = render(
      <PaneFooter session={makeSession({ status: 'error' })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not render the aliveness segment for a starting session', () => {
    render(<PaneFooter session={makeSession({ status: 'starting' })} />);
    expect(screen.queryByTestId('pane-aliveness')).toBeNull();
  });
});

// FEAT-12 — drop-zone tests.
describe('PaneFooter — FEAT-12 drop-zone', () => {
  const PANE_MIME = 'application/sigmalink-pane';

  function makePayload(overrides: Partial<{
    sessionId: string; branch: string | null; worktreePath: string | null; providerId: string;
  }> = {}) {
    return JSON.stringify({
      kind: 'pane',
      sessionId: 'source-sess',
      branch: 'main',
      worktreePath: '/wt/main',
      providerId: 'claude',
      ...overrides,
    });
  }

  beforeEach(() => {
    // FEAT-12 tests use real timers so that waitFor resolves correctly;
    // the outer beforeEach sets fake timers but we override here.
    vi.useRealTimers();
    vi.mocked(buildPaneContext).mockResolvedValue('ctx-block');
    vi.mocked(insertMention).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders a footer element with data-testid=pane-footer for running sessions', () => {
    render(<PaneFooter session={makeSession({ status: 'running' })} />);
    expect(screen.getByTestId('pane-footer')).toBeTruthy();
  });

  it('does not render for exited sessions (no drop zone needed)', () => {
    const { container } = render(<PaneFooter session={makeSession({ status: 'exited' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows ring highlight when PANE_DRAG_MIME is dragged over', () => {
    render(<PaneFooter session={makeSession({ status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.dragOver(footer, {
      dataTransfer: { types: [PANE_MIME] },
    });
    expect(footer.className).toMatch(/ring-2/);
    expect(footer.className).toMatch(/ring-primary/);
  });

  it('shows "drop to inject context" hint during dragOver', () => {
    render(<PaneFooter session={makeSession({ status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.dragOver(footer, {
      dataTransfer: { types: [PANE_MIME] },
    });
    expect(screen.getByTestId('pane-footer-drop-hint')).toBeTruthy();
  });

  it('clears ring highlight on dragLeave', () => {
    render(<PaneFooter session={makeSession({ status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.dragOver(footer, { dataTransfer: { types: [PANE_MIME] } });
    // simulate leaving entirely (relatedTarget outside the footer)
    fireEvent.dragLeave(footer, { relatedTarget: document.body });
    expect(footer.className).not.toMatch(/ring-2/);
  });

  it('does NOT activate highlight for unrelated MIME types', () => {
    render(<PaneFooter session={makeSession({ status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.dragOver(footer, { dataTransfer: { types: ['text/plain'] } });
    expect(footer.className).not.toMatch(/ring-2/);
  });

  it('calls buildPaneContext + insertMention when pane is dropped', async () => {
    render(<PaneFooter session={makeSession({ id: 'target-sess', status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.drop(footer, {
      dataTransfer: {
        getData: (mime: string) => mime === PANE_MIME ? makePayload({ sessionId: 'source-sess' }) : '',
        types: [PANE_MIME],
      },
    });
    await waitFor(() => {
      expect(buildPaneContext).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'source-sess', branch: 'main' }),
      );
      expect(insertMention).toHaveBeenCalledWith('target-sess', 'ctx-block', 'running');
    });
  });

  it('does NOT call buildPaneContext when the dropped pane is the same session', async () => {
    render(<PaneFooter session={makeSession({ id: 'same-sess', status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.drop(footer, {
      dataTransfer: {
        getData: (mime: string) => mime === PANE_MIME ? makePayload({ sessionId: 'same-sess' }) : '',
        types: [PANE_MIME],
      },
    });
    // Wait a tick then assert no calls.
    await act(async () => { await Promise.resolve(); });
    expect(buildPaneContext).not.toHaveBeenCalled();
    expect(insertMention).not.toHaveBeenCalled();
  });

  it('shows loading state while buildPaneContext is in flight', async () => {
    let resolve!: (v: string) => void;
    vi.mocked(buildPaneContext).mockReturnValueOnce(
      new Promise<string>((res) => { resolve = res; }),
    );
    render(<PaneFooter session={makeSession({ id: 'target', status: 'running' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.drop(footer, {
      dataTransfer: {
        getData: (mime: string) => mime === PANE_MIME ? makePayload({ sessionId: 'other-sess' }) : '',
        types: [PANE_MIME],
      },
    });
    // Still in-flight — should show loading indicator.
    await waitFor(() => {
      expect(screen.queryByTestId('pane-footer-loading')).not.toBeNull();
    });
    // Resolve the promise.
    act(() => { resolve('ctx'); });
    await waitFor(() => {
      expect(screen.queryByTestId('pane-footer-loading')).toBeNull();
    });
  });
});
