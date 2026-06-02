// @vitest-environment jsdom
//
// P4 MEM-3 — TagsPane. Covers: renders tags + counts; clicking a tag calls
// onTagClick(tag); clicking the active tag clears it (null); refetches when
// refreshKey changes; empty state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const listTagsMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: {
      list_tags: (...args: unknown[]) => listTagsMock(...args),
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { TagsPane } from './TagsPane';

describe('TagsPane', () => {
  it('renders each tag with its count', async () => {
    listTagsMock.mockResolvedValue([
      { tag: 'daily', count: 3 },
      { tag: 'idea', count: 1 },
    ]);

    render(<TagsPane workspaceId="ws" activeTag={null} onTagClick={vi.fn()} />);

    const dailyChip = await screen.findByTestId('tags-chip-daily');
    expect(dailyChip.textContent).toContain('daily');
    expect(dailyChip.textContent).toContain('3');

    const ideaChip = screen.getByTestId('tags-chip-idea');
    expect(ideaChip.textContent).toContain('idea');
    expect(ideaChip.textContent).toContain('1');

    expect(listTagsMock).toHaveBeenCalledWith({ workspaceId: 'ws' });
  });

  it('calls onTagClick(tag) when an inactive tag is clicked', async () => {
    listTagsMock.mockResolvedValue([{ tag: 'daily', count: 3 }]);
    const onTagClick = vi.fn();

    render(<TagsPane workspaceId="ws" activeTag={null} onTagClick={onTagClick} />);

    fireEvent.click(await screen.findByTestId('tags-chip-daily'));
    expect(onTagClick).toHaveBeenCalledWith('daily');
  });

  it('clears the filter (null) when the active tag is clicked again', async () => {
    listTagsMock.mockResolvedValue([{ tag: 'daily', count: 3 }]);
    const onTagClick = vi.fn();

    render(<TagsPane workspaceId="ws" activeTag="daily" onTagClick={onTagClick} />);

    const chip = await screen.findByTestId('tags-chip-daily');
    expect(chip.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(chip);
    expect(onTagClick).toHaveBeenCalledWith(null);
  });

  it('clears via the "All notes" affordance', async () => {
    listTagsMock.mockResolvedValue([{ tag: 'daily', count: 3 }]);
    const onTagClick = vi.fn();

    render(<TagsPane workspaceId="ws" activeTag="daily" onTagClick={onTagClick} />);

    fireEvent.click(await screen.findByTestId('tags-all'));
    expect(onTagClick).toHaveBeenCalledWith(null);
  });

  it('refetches tags when refreshKey changes', async () => {
    listTagsMock.mockResolvedValueOnce([{ tag: 'daily', count: 1 }]);

    const { rerender } = render(
      <TagsPane workspaceId="ws" activeTag={null} onTagClick={vi.fn()} refreshKey={0} />,
    );
    await screen.findByTestId('tags-chip-daily');
    expect(listTagsMock).toHaveBeenCalledTimes(1);

    listTagsMock.mockResolvedValueOnce([
      { tag: 'daily', count: 1 },
      { tag: 'idea', count: 2 },
    ]);
    rerender(
      <TagsPane workspaceId="ws" activeTag={null} onTagClick={vi.fn()} refreshKey={1} />,
    );

    await screen.findByTestId('tags-chip-idea');
    expect(listTagsMock).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state when there are no tags', async () => {
    listTagsMock.mockResolvedValue([]);

    render(<TagsPane workspaceId="ws" activeTag={null} onTagClick={vi.fn()} />);

    expect(await screen.findByTestId('tags-empty')).toBeDefined();
  });
});
