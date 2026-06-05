// @vitest-environment jsdom
//
// Phase 4 C2 — PaneSplash unit tests.
//
// Covers:
//  1. Splash renders for a 'running' session (before first byte).
//  2. The idle meta line (pane-splash-meta) shows modelLabel · effortLabel · cwd.
//  3. Splash hides for 'exited' and 'error' sessions.
//  4. The meta line is muted (for visual regression reference only; class tested).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AgentSession } from '@/shared/types';

// ── Mock: subscribePtyData — returns a no-op unsubscribe so no real bus ──────
vi.mock('@/renderer/lib/pty-data-bus', () => ({
  subscribePtyData: vi.fn(() => () => undefined),
}));

// ── Mock: findProvider — returns a stable provider shape ──────────────────────
vi.mock('@/shared/providers', () => ({
  findProvider: vi.fn((id: string) => ({
    id,
    name: id === 'claude' ? 'Claude' : id.toUpperCase(),
    color: '#a78bfa',
  })),
}));

// ── Mock: derivePaneIdentity via pane-identity ────────────────────────────────
// We need pane-identity to work; its dependencies (workspace-color, shared/*)
// are pure so we let them run real — just ensure the correct shape is returned.
// Alternatively we mock pane-identity directly for speed/isolation.
vi.mock('./pane-identity', () => ({
  derivePaneIdentity: vi.fn((session: AgentSession) => ({
    alias: 'Ava',
    agentId: 'ab12',
    agentAccent: '#a78bfa',
    providerName: 'Claude',
    providerColor: '#a78bfa',
    providerShort: 'Claude',
    realProviderName: 'Claude',
    isRelabelled: false,
    modelLabel: 'Opus 4.7 (1M)',
    effortLabel: 'max',
    branch: session.branch ?? 'dev',
    cwd: session.cwd,
    worktreePath: session.worktreePath ?? null,
  })),
}));

import { PaneSplash } from './PaneSplash';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/code/project',
    branch: 'main',
    status: 'running',
    startedAt: Date.now(),
    worktreePath: null,
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaneSplash', () => {
  describe('C2 — idle meta line', () => {
    it('renders the pane-splash-meta element for a running session', () => {
      render(<PaneSplash session={makeSession()} />);
      expect(screen.getByTestId('pane-splash-meta')).toBeTruthy();
    });

    it('meta line contains the model tier label', () => {
      render(<PaneSplash session={makeSession()} />);
      const meta = screen.getByTestId('pane-splash-meta');
      expect(meta.textContent).toContain('Opus 4.7 (1M)');
    });

    it('meta line contains the effort label', () => {
      render(<PaneSplash session={makeSession()} />);
      const meta = screen.getByTestId('pane-splash-meta');
      expect(meta.textContent).toContain('max');
    });

    it('meta line contains the cwd', () => {
      render(<PaneSplash session={makeSession({ cwd: '/repo/sigma' })} />);
      const meta = screen.getByTestId('pane-splash-meta');
      expect(meta.textContent).toContain('/repo/sigma');
    });

    it('meta line has muted styling class', () => {
      render(<PaneSplash session={makeSession()} />);
      const meta = screen.getByTestId('pane-splash-meta');
      expect(meta.className).toMatch(/text-muted-foreground/);
    });
  });

  describe('visibility', () => {
    it('renders nothing for an exited session', () => {
      const { container } = render(<PaneSplash session={makeSession({ status: 'exited' })} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing for an error session', () => {
      const { container } = render(<PaneSplash session={makeSession({ status: 'error' })} />);
      expect(container.firstChild).toBeNull();
    });

    it('hides after the 4-second safety timeout', () => {
      const { container } = render(<PaneSplash session={makeSession()} />);
      expect(container.firstChild).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      // after timeout the component re-renders to null
      expect(container.firstChild).toBeNull();
    });
  });
});
