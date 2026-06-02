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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
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

import { PaneFooter } from './PaneFooter';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import { PROGRESS_VERBS } from './progress-verbs';

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
