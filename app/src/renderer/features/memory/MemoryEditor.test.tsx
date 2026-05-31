// @vitest-environment jsdom
//
// UX-3 — MemoryEditor confirm dialogs. The delete + "create missing wikilink"
// confirms are now themed AlertDialogs (was window.confirm). These tests assert
// the delete RPC fires only after confirming, and the wikilink-create confirm
// gates create_memory + navigation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { Memory } from '@/shared/types';

const deleteMemoryMock = vi.fn().mockResolvedValue(undefined);
const createMemoryMock = vi.fn().mockResolvedValue({} as Memory);
const updateMemoryMock = vi.fn().mockResolvedValue({} as Memory);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: {
      delete_memory: (...a: unknown[]) => deleteMemoryMock(...a),
      create_memory: (...a: unknown[]) => createMemoryMock(...a),
      update_memory: (...a: unknown[]) => updateMemoryMock(...a),
    },
  },
}));

import { MemoryEditor } from './MemoryEditor';

const MEM: Memory = {
  id: 'm1',
  workspaceId: 'ws-1',
  name: 'Alpha',
  body: 'see [[Beta]] for details',
  tags: [],
  links: ['Beta'],
  createdAt: 0,
  updatedAt: 0,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderEditor(overrides: Partial<React.ComponentProps<typeof MemoryEditor>> = {}) {
  const props = {
    workspaceId: 'ws-1',
    memory: MEM,
    knownNames: new Set<string>(['alpha']),
    onNavigate: vi.fn(),
    onSaved: vi.fn(),
    onDeleted: vi.fn(),
    ...overrides,
  };
  render(<MemoryEditor {...props} />);
  return props;
}

describe('MemoryEditor — UX-3 delete confirm', () => {
  it('does not delete until the themed confirm is accepted', async () => {
    const props = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    // Cancel → no delete.
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteMemoryMock).not.toHaveBeenCalled();

    // Re-open + confirm → delete fires.
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog2 = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(dialog2).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(deleteMemoryMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', name: 'Alpha' });
      expect(props.onDeleted).toHaveBeenCalledWith('m1');
    });
  });
});

describe('MemoryEditor — UX-3 wikilink-create confirm', () => {
  it('confirms before creating a missing wikilink target, then navigates', async () => {
    // knownNames excludes "beta" → clicking the wikilink should prompt.
    const props = renderEditor({ knownNames: new Set<string>(['alpha']) });

    // Switch to preview so the wikilink button renders.
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    fireEvent.click(await screen.findByRole('button', { name: /beta/i }));

    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: /create note/i }));

    await waitFor(() => {
      expect(createMemoryMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', name: 'Beta' });
      expect(props.onNavigate).toHaveBeenCalledWith('Beta');
    });
  });

  it('navigates immediately for an existing wikilink target (no confirm)', async () => {
    const props = renderEditor({ knownNames: new Set<string>(['alpha', 'beta']) });

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    fireEvent.click(await screen.findByRole('button', { name: /beta/i }));

    await waitFor(() => expect(props.onNavigate).toHaveBeenCalledWith('Beta'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(createMemoryMock).not.toHaveBeenCalled();
  });
});
