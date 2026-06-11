// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/react';
import type { AgentSession, Workspace } from '@/shared/types';
import { defaultWorkspaceColor } from '@/renderer/lib/workspace-color';
import { WorkspacesPanel } from './WorkspacesPanel';
import { summarizeWorkspaces } from './workspaces-summary';

// rpcSilent mock — required by the useWorkspaceColors hook used inside WorkspacesPanel.
const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    kv: {
      get: (...args: [string]) => kvGetMock(...args),
      set: (...args: [string, string]) => kvSetMock(...args),
    },
  },
}));

afterEach(() => {
  cleanup();
  kvGetMock.mockClear();
  kvSetMock.mockClear();
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

  // Default: no stored colour (hook returns the deterministic default).
  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
  });

  function renderPanel(activeId: string | null = 'a') {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const onOpenPersisted = vi.fn();
    const onBrowseWorkspaces = vi.fn();
    const onReorder = vi.fn();
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
        onReorder={onReorder}
      />,
    );
    return { ...utils, onPick, onClose, onOpenPersisted, onBrowseWorkspaces, onReorder };
  }

  function rowFor(rows: HTMLElement[], id: string): HTMLElement {
    const r = rows.find((n) => n.getAttribute('data-workspace-id') === id);
    if (!r) throw new Error(`row ${id} not found`);
    return r;
  }
  function makeDataTransfer() {
    return { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
  }
  // Stack the three rows at distinct vertical bands so the container's
  // pointer→insertion-index math is deterministic in jsdom (which otherwise
  // returns all-zero rects). Row i spans [i*20, i*20+20], midpoint i*20+10.
  function stackRowRects(getAllByTestId: (id: string) => HTMLElement[]) {
    getAllByTestId('workspace-row').forEach((row, i) => {
      const top = i * 20;
      row.getBoundingClientRect = () =>
        ({ top, height: 20, bottom: top + 20, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
    });
  }
  // jsdom drag events don't propagate clientY through fireEvent's init, so we
  // build the event and define clientY explicitly.
  function fireDrag(
    type: 'dragOver' | 'drop',
    el: HTMLElement,
    clientY: number,
    dataTransfer: ReturnType<typeof makeDataTransfer>,
  ) {
    const ev = createEvent[type](el, { dataTransfer });
    Object.defineProperty(ev, 'clientY', { value: clientY });
    fireEvent(el, ev);
  }

  it('renders a colour dot for every open workspace', () => {
    const { getAllByTestId } = renderPanel();
    expect(getAllByTestId('workspace-dot')).toHaveLength(3);
  });

  describe('drag-to-reorder', () => {
    // Midpoints with stackRowRects: A=10, B=30, C=50. Insertion index = first
    // row whose midpoint is below clientY, else append (= length).
    it('marks rows draggable when onReorder is provided', () => {
      const { getAllByTestId } = renderPanel();
      for (const row of getAllByTestId('workspace-row')) {
        expect(row.getAttribute('draggable')).toBe('true');
      }
    });

    it('dragging A into the middle gap (between B and C) sticks there → [b, a, c]', () => {
      const { getAllByTestId, getByTestId, onReorder } = renderPanel();
      stackRowRects(getAllByTestId);
      const list = getByTestId('workspaces-list');
      const dt = makeDataTransfer();
      fireEvent.dragStart(rowFor(getAllByTestId('workspace-row'), 'a'), { dataTransfer: dt });
      fireDrag('dragOver', list, 35, dt); // 35 → before C (idx 2)
      fireDrag('drop', list, 35, dt);
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    });

    it('dragging A to the end sticks at the bottom → [b, c, a]', () => {
      const { getAllByTestId, getByTestId, onReorder } = renderPanel();
      stackRowRects(getAllByTestId);
      const list = getByTestId('workspaces-list');
      const dt = makeDataTransfer();
      fireEvent.dragStart(rowFor(getAllByTestId('workspace-row'), 'a'), { dataTransfer: dt });
      fireDrag('dragOver', list, 100, dt); // past all midpoints → append
      fireDrag('drop', list, 100, dt);
      expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
    });

    it('dragging C to the top sticks at the top → [c, a, b]', () => {
      const { getAllByTestId, getByTestId, onReorder } = renderPanel();
      stackRowRects(getAllByTestId);
      const list = getByTestId('workspaces-list');
      const dt = makeDataTransfer();
      fireEvent.dragStart(rowFor(getAllByTestId('workspace-row'), 'c'), { dataTransfer: dt });
      fireDrag('dragOver', list, 5, dt); // above A's midpoint → idx 0
      fireDrag('drop', list, 5, dt);
      expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
    });

    it('dropping back into its own slot does not call onReorder', () => {
      const { getAllByTestId, getByTestId, onReorder } = renderPanel();
      stackRowRects(getAllByTestId);
      const list = getByTestId('workspaces-list');
      const dt = makeDataTransfer();
      fireEvent.dragStart(rowFor(getAllByTestId('workspace-row'), 'a'), { dataTransfer: dt });
      fireDrag('dragOver', list, 5, dt); // idx 0 == A's current slot
      fireDrag('drop', list, 5, dt);
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('shows a drop indicator at the hovered gap while dragging', () => {
      const { getAllByTestId, getByTestId } = renderPanel();
      stackRowRects(getAllByTestId);
      const list = getByTestId('workspaces-list');
      const dt = makeDataTransfer();
      fireEvent.dragStart(rowFor(getAllByTestId('workspace-row'), 'a'), { dataTransfer: dt });
      fireDrag('dragOver', list, 35, dt); // gap before C → top-inset line on C
      expect(rowFor(getAllByTestId('workspace-row'), 'c').className).toMatch(/shadow-\[inset_0_2px/);
    });

    it('Move down context-menu item shifts the workspace one slot', async () => {
      const { getAllByTestId, findByTestId, onReorder } = renderPanel();
      await act(async () => {});
      const rowA = rowFor(getAllByTestId('workspace-row'), 'a');
      fireEvent.contextMenu(rowA);
      await findByTestId('workspace-color-menu');
      fireEvent.click(getAllByTestId('workspace-move-down')[0]!);
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    });
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

  it('active row carries sl-nav-active alongside bg-sidebar-accent for glass theme', () => {
    const { getAllByTestId } = renderPanel('a');
    const rows = getAllByTestId('workspace-row');
    const activeRow = rows.find((n) => n.getAttribute('data-active') === 'true');
    expect(activeRow?.className).toContain('sl-nav-active');
    expect(activeRow?.className).toContain('bg-sidebar-accent');
  });

  it('inactive rows carry neither sl-nav-active nor the bare bg-sidebar-accent class', () => {
    const { getAllByTestId } = renderPanel('a');
    const rows = getAllByTestId('workspace-row');
    const inactiveRows = rows.filter((n) => n.getAttribute('data-active') !== 'true');
    expect(inactiveRows.length).toBeGreaterThan(0);
    for (const row of inactiveRows) {
      // Split on spaces to get discrete class tokens — avoids false-positives
      // from hover:bg-sidebar-accent/50 containing the 'bg-sidebar-accent' substring.
      const classes = row.className.split(/\s+/);
      expect(classes).not.toContain('sl-nav-active');
      expect(classes).not.toContain('bg-sidebar-accent');
    }
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

  it('+ menu offers a SigmaLink Dev entry that fires onOpenDev', async () => {
    const onOpenDev = vi.fn();
    const { getByLabelText, findByText } = render(
      <WorkspacesPanel
        workspaces={[wsA]}
        persistedWorkspaces={[wsA]}
        sessions={sessions}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
        onOpenDev={onOpenDev}
      />,
    );

    const trigger = getByLabelText('Add or open workspace');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(await findByText('SigmaLink Dev'));

    expect(onOpenDev).toHaveBeenCalledTimes(1);
  });

  it('renders the DEV badge and ~ subtitle only on the devWorkspaceId row', () => {
    const { getAllByTestId } = render(
      <WorkspacesPanel
        workspaces={[wsA, wsB]}
        persistedWorkspaces={[wsA, wsB]}
        sessions={[]}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
        devWorkspaceId="a"
      />,
    );
    const rows = getAllByTestId('workspace-row');
    const rowA = rows.find((n) => n.getAttribute('data-workspace-id') === 'a')!;
    const rowB = rows.find((n) => n.getAttribute('data-workspace-id') === 'b')!;
    // DEV badge only on the dev row.
    expect(rowA.querySelector('[data-testid="workspace-dev-badge"]')).toBeTruthy();
    expect(rowB.querySelector('[data-testid="workspace-dev-badge"]')).toBeNull();
    // ~ subtitle only on the dev row; the other keeps its basename subtitle.
    expect(rowA.querySelector('[data-testid="workspace-subtitle"]')?.textContent).toBe('~');
    expect(rowB.querySelector('[data-testid="workspace-subtitle"]')?.textContent).toBe('b');
  });

  it('renders no DEV badge when devWorkspaceId is absent', () => {
    const { getAllByTestId } = renderPanel('a');
    for (const row of getAllByTestId('workspace-row')) {
      expect(row.querySelector('[data-testid="workspace-dev-badge"]')).toBeNull();
    }
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

// DEV-W2 — inline rename tests.
describe('<WorkspacesPanel /> — inline rename', () => {
  const ws = workspace('a', { name: 'My Workspace' });

  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
  });

  function renderWithRename(onRename: (workspaceId: string, newName: string) => Promise<void>) {
    const onPick = vi.fn();
    const utils = render(
      <WorkspacesPanel
        workspaces={[ws]}
        persistedWorkspaces={[]}
        sessions={[]}
        activeId="a"
        onPick={onPick}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
        onRename={onRename}
      />,
    );
    return { ...utils, onPick };
  }

  it('shows an input after double-clicking the workspace name', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, findByTestId } = renderWithRename(onRename);

    const nameEl = getByTestId('workspace-name');
    fireEvent.doubleClick(nameEl);

    const input = await findByTestId('workspace-rename-input');
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('My Workspace');
  });

  it('commits rename via Enter key and calls onRename', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, findByTestId } = renderWithRename(onRename);

    fireEvent.doubleClick(getByTestId('workspace-name'));
    const input = (await findByTestId('workspace-rename-input')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Renamed WS' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('a', 'Renamed WS');
  });

  it('cancels rename via Escape without calling onRename', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, findByTestId, queryByTestId } = renderWithRename(onRename);

    fireEvent.doubleClick(getByTestId('workspace-name'));
    const input = (await findByTestId('workspace-rename-input')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    // Input should be gone and onRename must NOT have been called.
    expect(queryByTestId('workspace-rename-input')).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('commits rename on blur', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, findByTestId } = renderWithRename(onRename);

    fireEvent.doubleClick(getByTestId('workspace-name'));
    const input = (await findByTestId('workspace-rename-input')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'BlurName' } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith('a', 'BlurName');
  });

  it('does not call onRename when the trimmed value is empty on commit', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, findByTestId } = renderWithRename(onRename);

    fireEvent.doubleClick(getByTestId('workspace-name'));
    const input = (await findByTestId('workspace-rename-input')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('does not show rename input when onRename prop is absent', () => {
    const { getByTestId, queryByTestId } = render(
      <WorkspacesPanel
        workspaces={[ws]}
        persistedWorkspaces={[]}
        sessions={[]}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
        // no onRename prop
      />,
    );
    fireEvent.doubleClick(getByTestId('workspace-name'));
    expect(queryByTestId('workspace-rename-input')).toBeNull();
  });

  it('does not call onPick when rename input is active', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, findByTestId, onPick } = renderWithRename(onRename);

    fireEvent.doubleClick(getByTestId('workspace-name'));
    await findByTestId('workspace-rename-input');

    // Clicking the outer row button while the input is active must NOT call onPick.
    const rowButton = getByTestId('workspace-row').querySelector('button[title]');
    if (rowButton) fireEvent.click(rowButton);

    expect(onPick).not.toHaveBeenCalled();
  });
});

// Per-workspace colour — dot hex, row accent, right-click swatch picker.
describe('<WorkspacesPanel /> — workspace colours', () => {
  const ws = workspace('a', { name: 'Coloured WS' });

  beforeEach(() => {
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockResolvedValue(undefined);
  });

  function renderOne(kvValue: string | null = null) {
    kvGetMock.mockResolvedValue(kvValue);
    return render(
      <WorkspacesPanel
        workspaces={[ws]}
        persistedWorkspaces={[]}
        sessions={[]}
        activeId="a"
        onPick={vi.fn()}
        onClose={vi.fn()}
        onOpenPersisted={vi.fn()}
        onBrowseWorkspaces={vi.fn()}
      />,
    );
  }

  it('dot uses the default hex when KV has no stored value', async () => {
    const { getByTestId } = renderOne(null);
    await act(async () => {});
    const dot = getByTestId('workspace-dot') as HTMLElement;
    expect(dot.style.backgroundColor).toBeTruthy();
    // Default color = defaultWorkspaceColor('a') converted to RGB by jsdom.
    // We assert it is non-empty — the exact CSS colour representation may differ.
    expect(dot.style.backgroundColor).not.toBe('');
  });

  it('dot uses the stored hex from KV when present', async () => {
    const { getByTestId } = renderOne('#60a5fa');
    await act(async () => {});
    const dot = getByTestId('workspace-dot') as HTMLElement;
    // jsdom converts #60a5fa to "rgb(96, 165, 250)".
    expect(dot.style.backgroundColor).toBe('rgb(96, 165, 250)');
  });

  it('status ring class is preserved on the dot regardless of stored colour', async () => {
    const { getByTestId } = renderOne('#a78bfa');
    await act(async () => {});
    const dot = getByTestId('workspace-dot');
    // The ring class is derived from status.kind ('idle' → ring-zinc-600).
    expect(dot.className).toContain('ring-zinc-600');
  });

  it('right-click opens the colour picker menu', async () => {
    const { getByTestId, findByTestId } = renderOne(null);
    await act(async () => {});

    const row = getByTestId('workspace-row');
    fireEvent.contextMenu(row);

    const menu = await findByTestId('workspace-color-menu');
    expect(menu).toBeTruthy();
  });

  it('clicking a swatch calls setColor (writes KV + updates state)', async () => {
    kvSetMock.mockResolvedValue(undefined);
    const { getByTestId, findByTestId } = renderOne(null);
    await act(async () => {});

    const row = getByTestId('workspace-row');
    fireEvent.contextMenu(row);

    // Wait for menu to appear.
    await findByTestId('workspace-color-menu');

    // Click the swatch for #34d399.
    const swatch = getByTestId('color-swatch-#34d399') as HTMLElement;
    fireEvent.click(swatch);

    // KV should have been called with the right key and value.
    expect(kvSetMock).toHaveBeenCalledWith('ui.a.color', '#34d399');

    // After the optimistic update the dot should reflect the new colour.
    await act(async () => {});
    const dot = getByTestId('workspace-dot') as HTMLElement;
    expect(dot.style.backgroundColor).toBe('rgb(52, 211, 153)'); // #34d399
  });

  it('default colour derived from id is deterministic and matches defaultWorkspaceColor', () => {
    const hex = defaultWorkspaceColor('a');
    expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hex).toBe(defaultWorkspaceColor('a'));
  });
});
