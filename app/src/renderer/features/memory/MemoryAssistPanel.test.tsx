// @vitest-environment jsdom
//
// MEM-6 — MemoryAssistPanel: orphans + suggested connections.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Memory, MemoryConnectionSuggestion } from '@/shared/types';

// ── Mocks ────────────────────────────────────────────────────────────────────

const listOrphansMock = vi.fn();
const suggestConnectionsMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    memory: {
      list_orphans: (...a: unknown[]) => listOrphansMock(...a),
      suggest_connections: (...a: unknown[]) => suggestConnectionsMock(...a),
    },
  },
}));

import { MemoryAssistPanel } from './MemoryAssistPanel';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORPHAN_A: Memory = {
  id: 'o1',
  workspaceId: 'ws-1',
  name: 'Orphan Alpha',
  body: '',
  tags: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
};

const ORPHAN_B: Memory = {
  id: 'o2',
  workspaceId: 'ws-1',
  name: 'Orphan Beta',
  body: '',
  tags: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
};

const SUGGESTION_1: MemoryConnectionSuggestion = {
  id: 's1',
  name: 'Related Note',
  sharedTags: ['ai', 'research'],
  score: 0.87,
};

const SUGGESTION_2: MemoryConnectionSuggestion = {
  id: 's2',
  name: 'Another Note',
  sharedTags: ['ai'],
  score: 0.65,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof MemoryAssistPanel>> = {},
) {
  const props = {
    workspaceId: 'ws-1',
    activeName: null as string | null,
    onSelect: vi.fn(),
    ...overrides,
  };
  return { ...render(<MemoryAssistPanel {...props} />), props };
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? '';
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemoryAssistPanel — orphans', () => {
  it('renders orphan note names and clicking calls onSelect', async () => {
    listOrphansMock.mockResolvedValue([ORPHAN_A, ORPHAN_B]);
    suggestConnectionsMock.mockResolvedValue([]);

    const { props } = renderPanel({ activeName: null });

    await waitFor(() => screen.getByTestId('orphan-item-o1'));

    expect(text('orphan-item-o1')).toContain('Orphan Alpha');
    expect(text('orphan-item-o2')).toContain('Orphan Beta');

    fireEvent.click(screen.getByTestId('orphan-item-o1'));
    expect(props.onSelect).toHaveBeenCalledWith('Orphan Alpha');
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows count badge with correct number', async () => {
    listOrphansMock.mockResolvedValue([ORPHAN_A, ORPHAN_B]);
    suggestConnectionsMock.mockResolvedValue([]);

    renderPanel({ activeName: null });

    await waitFor(() => screen.getByTestId('orphan-item-o1'));

    expect(text('orphans-section-badge')).toBe('2');
  });

  it('shows empty state when no orphans', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockResolvedValue([]);

    renderPanel({ activeName: null });

    await waitFor(() => screen.getByTestId('orphans-empty'));
    expect(text('orphans-empty')).toContain('No orphan notes.');
  });

  it('degrades gracefully to empty list when list_orphans rejects', async () => {
    listOrphansMock.mockRejectedValue(new Error('network error'));
    suggestConnectionsMock.mockResolvedValue([]);

    renderPanel({ activeName: null });

    await waitFor(() => screen.getByTestId('orphans-empty'));
    expect(text('orphans-empty')).toContain('No orphan notes.');
  });
});

describe('MemoryAssistPanel — suggested connections', () => {
  it('renders suggestions with sharedTags chips and score when activeName is set', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockResolvedValue([SUGGESTION_1, SUGGESTION_2]);

    renderPanel({ activeName: 'My Note' });

    await waitFor(() => screen.getByTestId('suggestion-item-s1'));

    expect(text('suggestion-item-s1')).toContain('Related Note');
    expect(text('suggestion-tag-s1-ai')).toBe('ai');
    expect(text('suggestion-tag-s1-research')).toBe('research');
    expect(text('suggestion-score-s1')).toBe('0.87');

    expect(text('suggestion-item-s2')).toContain('Another Note');
    expect(text('suggestion-tag-s2-ai')).toBe('ai');
    expect(text('suggestion-score-s2')).toBe('0.65');
  });

  it('clicking a suggestion calls onSelect with the suggestion name', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockResolvedValue([SUGGESTION_1]);

    const { props } = renderPanel({ activeName: 'My Note' });

    await waitFor(() => screen.getByTestId('suggestion-item-s1'));
    fireEvent.click(screen.getByTestId('suggestion-item-s1'));

    expect(props.onSelect).toHaveBeenCalledWith('Related Note');
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows empty state "No suggestions for this note" when suggestions are empty', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockResolvedValue([]);

    renderPanel({ activeName: 'Some Note' });

    await waitFor(() => screen.getByTestId('suggestions-empty'));
    expect(text('suggestions-empty')).toContain('No suggestions for this note.');
  });

  it('shows "Select a note" prompt when activeName is null', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockResolvedValue([]);

    renderPanel({ activeName: null });

    // suggestions-no-active should appear; suggest_connections should NOT be called
    await waitFor(() => screen.getByTestId('suggestions-no-active'));
    expect(text('suggestions-no-active')).toContain('Select a note to see suggestions.');
    expect(suggestConnectionsMock).not.toHaveBeenCalled();
  });

  it('hides suggestion list (shows no-active) when activeName becomes null', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockResolvedValue([SUGGESTION_1]);

    const { rerender } = renderPanel({ activeName: 'My Note' });

    await waitFor(() => screen.getByTestId('suggestion-item-s1'));

    rerender(
      <MemoryAssistPanel
        workspaceId="ws-1"
        activeName={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByTestId('suggestions-no-active'));
    expect(screen.queryByTestId('suggestions-list')).toBeNull();
  });

  it('degrades gracefully to empty state when suggest_connections rejects', async () => {
    listOrphansMock.mockResolvedValue([]);
    suggestConnectionsMock.mockRejectedValue(new Error('rpc error'));

    renderPanel({ activeName: 'My Note' });

    await waitFor(() => screen.getByTestId('suggestions-empty'));
    expect(text('suggestions-empty')).toContain('No suggestions for this note.');
  });
});

describe('MemoryAssistPanel — refreshKey', () => {
  it('re-fetches when refreshKey changes', async () => {
    listOrphansMock.mockResolvedValue([ORPHAN_A]);
    suggestConnectionsMock.mockResolvedValue([]);

    const { rerender } = renderPanel({ activeName: null, refreshKey: 0 });

    await waitFor(() => screen.getByTestId('orphan-item-o1'));
    expect(listOrphansMock).toHaveBeenCalledTimes(1);

    listOrphansMock.mockResolvedValue([ORPHAN_A, ORPHAN_B]);
    rerender(
      <MemoryAssistPanel
        workspaceId="ws-1"
        activeName={null}
        onSelect={vi.fn()}
        refreshKey={1}
      />,
    );

    await waitFor(() => expect(listOrphansMock).toHaveBeenCalledTimes(2));
    await waitFor(() => screen.getByTestId('orphan-item-o2'));
  });
});
