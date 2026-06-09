// @vitest-environment jsdom
//
// PaneFooter is now a plain hairline (no aliveness verb, no auto/bypass hint, no
// padding). Tests cover: it renders a line for live sessions, nothing for
// exited/error, and the FEAT-12 drop target still injects pane context.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import type { AgentSession } from '@/shared/types';

vi.mock('@/renderer/lib/pane-context-builder', () => ({
  PANE_DRAG_MIME: 'application/sigmalink-pane',
  buildPaneContext: vi.fn().mockResolvedValue('ctx-block'),
}));
vi.mock('./insertMention', () => ({
  insertMention: vi.fn().mockResolvedValue(undefined),
}));

import { PaneFooter } from './PaneFooter';
import { buildPaneContext } from '@/renderer/lib/pane-context-builder';
import { insertMention } from './insertMention';

const PANE_MIME = 'application/sigmalink-pane';

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

function makePayload(sessionId: string): string {
  return JSON.stringify({
    kind: 'pane',
    sessionId,
    branch: 'main',
    worktreePath: '/wt/main',
    providerId: 'claude',
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PaneFooter — plain hairline', () => {
  it('renders a plain footer line for a running session (no text)', () => {
    render(<PaneFooter session={makeSession()} />);
    const footer = screen.getByTestId('pane-footer');
    expect(footer).toBeTruthy();
    expect(footer.textContent).toBe(''); // no labels/verbs
    expect(footer.className).toMatch(/h-px/); // 1px line, no padding
  });

  it('renders null for an exited session', () => {
    const { container } = render(<PaneFooter session={makeSession({ status: 'exited' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null for an error session', () => {
    const { container } = render(<PaneFooter session={makeSession({ status: 'error' })} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('PaneFooter — FEAT-12 drop target', () => {
  beforeEach(() => {
    vi.mocked(buildPaneContext).mockResolvedValue('ctx-block');
    vi.mocked(insertMention).mockResolvedValue(undefined);
  });

  it('highlights while a pane is dragged over', () => {
    render(<PaneFooter session={makeSession()} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.dragOver(footer, { dataTransfer: { types: [PANE_MIME] } });
    expect(footer.className).toMatch(/bg-primary/);
    fireEvent.dragLeave(footer, { relatedTarget: document.body });
    expect(footer.className).not.toMatch(/bg-primary/);
  });

  it('ignores unrelated MIME types', () => {
    render(<PaneFooter session={makeSession()} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.dragOver(footer, { dataTransfer: { types: ['text/plain'] } });
    expect(footer.className).not.toMatch(/bg-primary/);
  });

  it('injects context on drop of a different pane', async () => {
    render(<PaneFooter session={makeSession({ id: 'target-sess' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.drop(footer, {
      dataTransfer: {
        getData: (mime: string) => (mime === PANE_MIME ? makePayload('source-sess') : ''),
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

  it('does not inject when dropping a pane onto itself', async () => {
    render(<PaneFooter session={makeSession({ id: 'same-sess' })} />);
    const footer = screen.getByTestId('pane-footer');
    fireEvent.drop(footer, {
      dataTransfer: {
        getData: (mime: string) => (mime === PANE_MIME ? makePayload('same-sess') : ''),
        types: [PANE_MIME],
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(buildPaneContext).not.toHaveBeenCalled();
    expect(insertMention).not.toHaveBeenCalled();
  });
});
