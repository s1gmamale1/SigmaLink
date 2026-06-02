// @vitest-environment jsdom
// MEM-7 — unlinked-mentions section + promote-to-link.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Memory, MemoryUnlinkedMention } from '@/shared/types';

const findBacklinksMock = vi.fn().mockResolvedValue([]);
const findUnlinkedMock = vi.fn();
const updateMemoryMock = vi.fn().mockResolvedValue({} as Memory);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: {
      find_backlinks: (...a: unknown[]) => findBacklinksMock(...a),
      find_unlinked_mentions: (...a: unknown[]) => findUnlinkedMock(...a),
      update_memory: (...a: unknown[]) => updateMemoryMock(...a),
    },
  },
}));

import { Backlinks, promoteMentionToLink } from './Backlinks';

const mkMem = (over: Partial<Memory>): Memory => ({
  id: 'id',
  workspaceId: 'ws-1',
  name: 'note',
  body: '',
  tags: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('promoteMentionToLink', () => {
  it('wraps the first whole-word mention in [[name]]', () => {
    expect(promoteMentionToLink('See Alpha here', 'Alpha')).toBe('See [[Alpha]] here');
  });

  it('preserves casing via an alias when it differs', () => {
    expect(promoteMentionToLink('see alpha', 'Alpha')).toBe('see [[Alpha|alpha]]');
  });

  it('skips text already inside a wikilink', () => {
    expect(promoteMentionToLink('[[Alpha]] and Alpha', 'Alpha')).toBe('[[Alpha]] and [[Alpha]]');
  });

  it('does not match substrings (whole-word only)', () => {
    expect(promoteMentionToLink('Alphabet soup', 'Alpha')).toBe('Alphabet soup');
  });

  it('returns the body unchanged when there is no mention', () => {
    expect(promoteMentionToLink('nothing here', 'Alpha')).toBe('nothing here');
  });
});

describe('Backlinks — MEM-7 unlinked mentions', () => {
  const SOURCE = mkMem({ id: 's1', name: 'Bravo', body: 'mentions Alpha in prose' });
  const mention: MemoryUnlinkedMention = {
    sourceId: 's1',
    sourceName: 'Bravo',
    excerpt: '…mentions Alpha in prose…',
  };

  it('lists unlinked mentions and promotes the source body on Link', async () => {
    findUnlinkedMock.mockResolvedValue([mention]);
    render(
      <Backlinks
        workspaceId="ws-1"
        noteName="Alpha"
        memoriesVersion={1}
        memories={[SOURCE]}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByTestId('unlinked-mentions'));
    fireEvent.click(screen.getByTestId('link-mention-s1'));
    await waitFor(() =>
      expect(updateMemoryMock).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        name: 'Bravo',
        body: 'mentions [[Alpha]] in prose',
      }),
    );
  });

  it('does not render the section when there are no mentions', async () => {
    findUnlinkedMock.mockResolvedValue([]);
    render(
      <Backlinks
        workspaceId="ws-1"
        noteName="Alpha"
        memoriesVersion={1}
        memories={[SOURCE]}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(findUnlinkedMock).toHaveBeenCalled());
    expect(screen.queryByTestId('unlinked-mentions')).toBeNull();
  });
});
