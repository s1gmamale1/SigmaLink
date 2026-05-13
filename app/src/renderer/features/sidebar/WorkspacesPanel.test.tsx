// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
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
    return { ...utils, onPick, onClose, onOpenPersisted, onBrowseWorkspaces };
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

  it('renders a hover close button for every workspace row', () => {
    const { getAllByTestId, onClose } = renderPanel('a');
    const closeButtons = getAllByTestId('workspace-close');
    expect(closeButtons).toHaveLength(3);
    const backgroundRow = getAllByTestId('workspace-row').find(
      (n) => n.getAttribute('data-workspace-id') === 'b',
    );
    const backgroundClose = backgroundRow?.querySelector('[data-testid="workspace-close"]');
    expect(backgroundClose).toBeTruthy();
    fireEvent.click(backgroundClose!);
    expect(onClose).toHaveBeenCalledWith('b');
  });

  it('marks the active row with sidebar accent styling', () => {
    const { getAllByTestId } = renderPanel('a');
    const activeRow = getAllByTestId('workspace-row').find(
      (n) => n.getAttribute('data-active') === 'true',
    );
    expect(activeRow?.className).toContain('bg-sidebar-accent');
  });

  it('opens persisted-but-closed workspaces from the chevron dropdown', async () => {
    const wsD = workspace('d', { name: 'Dormant Workspace', rootPath: '/tmp/dormant' });
    const onOpenPersisted = vi.fn();
    const { getByLabelText, findByText } = render(
      <WorkspacesPanel
        workspaces={[wsA, wsB, wsC]}
        persistedWorkspaces={[wsA, wsB, wsC, wsD]}
        sessions={sessions}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={onOpenPersisted}
        onBrowseWorkspaces={vi.fn()}
      />,
    );

    const trigger = getByLabelText('Workspace menu');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(await findByText('Dormant Workspace'));

    expect(onOpenPersisted).toHaveBeenCalledWith(wsD);
  });

  it('renders an empty-state placeholder + CTA when no workspaces are open', () => {
    // v1.2.5 — the empty state was upgraded from a one-line "No workspaces
    // open." string to a centred placeholder with an icon + "Open workspace"
    // CTA, matching the EmptyState idiom used elsewhere in the app.
    const { queryAllByTestId, getByText, getByTestId } = render(
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
    expect(getByTestId('workspaces-empty')).toBeTruthy();
    expect(getByText('No workspaces yet')).toBeTruthy();
    expect(getByTestId('workspaces-empty-cta')).toBeTruthy();
  });

  it('falls back to "Untitled workspace" when the workspace record has no name', () => {
    const { getByText } = render(
      <WorkspacesPanel
        workspaces={[workspace('a', { name: '' })]}
        persistedWorkspaces={[]}
        sessions={[]}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
      />,
    );
    expect(getByText('Untitled workspace')).toBeTruthy();
  });

  it('renders the root-path basename as a subtitle under the workspace name', () => {
    const { getByTestId } = render(
      <WorkspacesPanel
        workspaces={[workspace('a', { name: 'My Project', rootPath: '/Users/me/projects/sigmalink' })]}
        persistedWorkspaces={[]}
        sessions={[]}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
      />,
    );
    expect(getByTestId('workspace-subtitle').textContent).toBe('sigmalink');
  });
});
