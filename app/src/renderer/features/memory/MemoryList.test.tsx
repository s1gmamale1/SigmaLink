// @vitest-environment jsdom
// MEM-8 — two-step create: name → optional template picker → onCreate(name, body?).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Memory } from '@/shared/types';

// rpc is only used here for the semantic-search path; stub it so the list mounts.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { memory: { search_memories: vi.fn().mockResolvedValue([]) } },
  rpcSilent: { ruflo: { health: vi.fn().mockRejectedValue(new Error('off')) } },
  onEvent: () => () => undefined,
}));

import { MemoryList } from './MemoryList';

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

const TEMPLATE = mkMem({
  id: 't1',
  name: 'Meeting',
  body: '# Meeting\n- attendees:',
  tags: ['template'],
});
const PLAIN = mkMem({ id: 'p1', name: 'Alpha' });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList(memories: Memory[], onCreate = vi.fn()) {
  render(
    <MemoryList
      memories={memories}
      workspaceId="ws-1"
      activeName={null}
      onSelect={vi.fn()}
      onCreate={onCreate}
    />,
  );
  return { onCreate };
}

function openCreateAndType(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Create note' }));
  const input = screen.getByPlaceholderText('New note name…');
  fireEvent.change(input, { target: { value: name } });
  // Submit via the Create confirm button inside the prompt dialog.
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

describe('MemoryList — MEM-8 create flow', () => {
  it('creates a blank note directly when no templates exist', () => {
    const { onCreate } = renderList([PLAIN]);
    openCreateAndType('Beta');
    expect(onCreate).toHaveBeenCalledWith('Beta');
  });

  it('opens the template picker when templates exist and routes Blank → undefined body', async () => {
    const { onCreate } = renderList([PLAIN, TEMPLATE]);
    openCreateAndType('Gamma');
    // Picker appears; onCreate has NOT fired yet.
    expect(onCreate).not.toHaveBeenCalled();
    await waitFor(() => screen.getByTestId('create-template-blank'));
    fireEvent.click(screen.getByTestId('create-template-blank'));
    expect(onCreate).toHaveBeenCalledWith('Gamma', undefined);
  });

  it('seeds the new note with a chosen template body', async () => {
    const { onCreate } = renderList([PLAIN, TEMPLATE]);
    openCreateAndType('From template');
    await waitFor(() => screen.getByTestId('create-template-Meeting'));
    fireEvent.click(screen.getByTestId('create-template-Meeting'));
    expect(onCreate).toHaveBeenCalledWith('From template', TEMPLATE.body);
  });
});
