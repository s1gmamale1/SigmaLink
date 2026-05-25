// @vitest-environment jsdom
//
// Stage-4 UX — SessionList renders EmptyState when sessions array is empty.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { SessionList } from './SessionList';

describe('SessionList — Stage-4 UX', () => {
  it('renders EmptyState when sessions is empty', () => {
    render(
      <SessionList
        sessions={[]}
        activeId={null}
        selected={new Set()}
        onSelect={vi.fn()}
        onToggleCheck={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );

    // EmptyState renders with role="status"
    expect(screen.getByRole('status')).toBeDefined();
    // Title text
    expect(screen.getByText(/No sessions yet/i)).toBeDefined();
  });

  it('does NOT render EmptyState when sessions has entries', () => {
    const session = {
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      providerId: 'claude',
      branch: 'feat/foo',
      worktreePath: '/tmp/wt1',
      cwd: '/tmp/wt1',
      status: 'exited' as const,
      startedAt: 0,
      notes: '',
      decision: null,
      decidedAt: null,
      lastTestCommand: null,
      lastTestExitCode: null,
      gitStatus: null,
    };

    render(
      <SessionList
        sessions={[session]}
        activeId={null}
        selected={new Set()}
        onSelect={vi.fn()}
        onToggleCheck={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/No sessions yet/i)).toBeNull();
    expect(screen.getByText('claude')).toBeDefined();
  });

  it('renders ErrorBanner when error prop is provided', () => {
    render(
      <SessionList
        sessions={[]}
        activeId={null}
        selected={new Set()}
        onSelect={vi.fn()}
        onToggleCheck={vi.fn()}
        onToggleAll={vi.fn()}
        error="Failed to load sessions"
      />,
    );

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText(/Failed to load sessions/i)).toBeDefined();
  });
});
