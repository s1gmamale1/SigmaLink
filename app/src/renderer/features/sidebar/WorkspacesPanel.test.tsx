// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AgentSession, Workspace } from '@/shared/types';
import { WorkspacesPanel } from './WorkspacesPanel';
import { summarizeWorkspaces } from './workspaces-summary';

afterEach(() => {
  cleanup();
});

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Workspace ${id.toUpperCase()}`,
    rootPath: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`,
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  };
}

function session(id: string, workspaceId: string, status: AgentSession['status']): AgentSession {
  return {
    id,
    workspaceId,
    providerId: 'claude',
    cwd: `/tmp/${workspaceId}`,
    branch: null,
    status,
    startedAt: 1,
    worktreePath: null,
  };
}

describe('summarizeWorkspaces', () => {
  it('counts running sessions and marks workspaces with errors', () => {
    const map = summarizeWorkspaces([
      session('s1', 'a', 'running'),
      session('s2', 'a', 'running'),
      session('s3', 'b', 'error'),
      session('s4', 'c', 'exited'),
    ]);
    expect(map.get('a')?.running).toBe(2);
    expect(map.get('a')?.kind).toBe('running');
    expect(map.get('b')?.kind).toBe('error');
    expect(map.get('b')?.running).toBe(0);
    expect(map.get('c')?.kind).toBe('idle');
  });

  it('returns an empty map when there are no sessions', () => {
    expect(summarizeWorkspaces([]).size).toBe(0);
  });
});

describe('<WorkspacesPanel />', () => {
  const wsA = workspace('a');
  const wsB = workspace('b');
  const wsC = workspace('c');
  const sessions: AgentSession[] = [
    session('s1', 'a', 'running'),
    session('s2', 'a', 'running'),
  ];

  function renderPanel(activeId: string | null = 'a') {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const onOpenPersisted = vi.fn();
    const onBrowseWorkspaces = vi.fn();
    const utils = render(
      <WorkspacesPanel
        workspaces={[wsA, wsB, wsC]}
        persistedWorkspaces={[wsA, wsB, wsC]}
        sessions={sessions}
        activeId={activeId}
        onPick={onPick}
        onClose={onClose}
        onOpenPersisted={onOpenPersisted}
        onBrowseWorkspaces={onBrowseWorkspaces}
      />,
    );
    return { ...utils, onPick, onClose };
  }

  it('renders a colour dot for every open workspace', () => {
    const { getAllByTestId } = renderPanel();
    expect(getAllByTestId('workspace-dot')).toHaveLength(3);
  });

  it('shows the pane-count badge with 2 for the workspace that owns two running sessions', () => {
    const { getAllByTestId } = renderPanel();
    const rows = getAllByTestId('workspace-row');
    const rowA = rows.find((node) => node.getAttribute('data-workspace-id') === 'a');
    expect(rowA).toBeTruthy();
    const badge = rowA!.querySelector('[data-testid="workspace-pane-count"]');
    expect(badge?.textContent).toBe('2');
  });

  it('only renders a close button on the active row', () => {
    const { getAllByTestId } = renderPanel('a');
    const closeButtons = getAllByTestId('workspace-close');
    expect(closeButtons).toHaveLength(1);
    const activeRow = getAllByTestId('workspace-row').find(
      (n) => n.getAttribute('data-active') === 'true',
    );
    expect(activeRow?.contains(closeButtons[0]!)).toBe(true);
  });

  it('renders an empty-state message when no workspaces are open', () => {
    const { queryAllByTestId, getByText } = render(
      <WorkspacesPanel
        workspaces={[]}
        persistedWorkspaces={[]}
        sessions={[]}
        activeId={null}
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
      />,
    );
    expect(queryAllByTestId('workspace-row')).toHaveLength(0);
    expect(getByText('No workspaces open.')).toBeTruthy();
  });
});
