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
const updateMemoryMock = vi
  .fn()
  .mockImplementation(async (input: { name: string; body: string; tags: string[] }) => ({
    ...MEM,
    body: input.body,
    tags: input.tags,
    updatedAt: MEM.updatedAt + 1,
  }));

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
  const view = render(<MemoryEditor {...props} />);
  return { props, rerender: view.rerender };
}

describe('MemoryEditor — UX-3 delete confirm', () => {
  it('does not delete until the themed confirm is accepted', async () => {
    const { props } = renderEditor();

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
    const { props } = renderEditor({ knownNames: new Set<string>(['alpha']) });

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
    const { props } = renderEditor({ knownNames: new Set<string>(['alpha', 'beta']) });

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    fireEvent.click(await screen.findByRole('button', { name: /beta/i }));

    await waitFor(() => expect(props.onNavigate).toHaveBeenCalledWith('Beta'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(createMemoryMock).not.toHaveBeenCalled();
  });
});

// BUG-11 — staleness / clobber protection. An external writer (agent MCP /
// sync) advancing `updatedAt` on the OPEN note must re-hydrate when clean, but
// must NOT silently discard unsaved local edits when dirty.
describe('MemoryEditor — BUG-11 staleness', () => {
  function textarea() {
    return screen.getByPlaceholderText(/write markdown/i) as HTMLTextAreaElement;
  }

  it('re-hydrates the textarea on an external updatedAt bump when there are no local edits', async () => {
    const { rerender, props } = renderEditor();
    // Wait out the deferred (queueMicrotask) initial hydration.
    await waitFor(() => expect(textarea().value).toBe(MEM.body));

    // External writer changed the note on disk (newer body + updatedAt).
    const updated: Memory = { ...MEM, body: 'rewritten by an agent', updatedAt: MEM.updatedAt + 5 };
    rerender(
      <MemoryEditor
        workspaceId="ws-1"
        memory={updated}
        knownNames={new Set(['alpha'])}
        onNavigate={props.onNavigate}
        onSaved={props.onSaved}
        onDeleted={props.onDeleted}
      />,
    );

    await waitFor(() => expect(textarea().value).toBe('rewritten by an agent'));
    // Clean re-hydrate must not show the reload banner.
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });

  it('shows a Reload banner (and does NOT clobber) on an external bump while dirty, until Reload is clicked', async () => {
    const { rerender, props } = renderEditor();
    await waitFor(() => expect(textarea().value).toBe(MEM.body));

    // Local edit → dirty.
    fireEvent.change(textarea(), { target: { value: 'my unsaved local edit' } });
    expect(textarea().value).toBe('my unsaved local edit');

    // External writer bumps updatedAt on the open note while we are dirty.
    const updated: Memory = { ...MEM, body: 'disk version', updatedAt: MEM.updatedAt + 5 };
    rerender(
      <MemoryEditor
        workspaceId="ws-1"
        memory={updated}
        knownNames={new Set(['alpha'])}
        onNavigate={props.onNavigate}
        onSaved={props.onSaved}
        onDeleted={props.onDeleted}
      />,
    );

    // Banner appears; local edits are preserved (NOT clobbered).
    const reloadBtn = await screen.findByRole('button', { name: /reload/i });
    expect(textarea().value).toBe('my unsaved local edit');

    // Click Reload → discard local edits, hydrate the disk version.
    fireEvent.click(reloadBtn);
    await waitFor(() => expect(textarea().value).toBe('disk version'));
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });
});

// MEM-1 — read-only mode for Ruflo virtual (agent-authored) notes.
describe('MemoryEditor — read-only (Ruflo) mode', () => {
  it('disables editing, hides Save/Delete, shows the namespace/score chip, and never calls write RPCs', async () => {
    renderEditor({
      readOnly: true,
      readOnlyMeta: { namespace: 'patterns', score: 0.62 },
    });

    const ta = screen.getByPlaceholderText(/write markdown/i) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe(MEM.body));

    // Textarea is read-only and shows the agent body (escaped React children).
    expect(ta.readOnly).toBe(true);

    // Save + Delete are gone.
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();

    // Read-only chip carries namespace + score.
    const chip = screen.getByTestId('readonly-chip');
    expect(chip.textContent).toContain('agent memory');
    expect(chip.textContent).toContain('patterns');
    expect(chip.textContent).toContain('0.62');

    // Editing attempts and time never trigger update/delete RPCs.
    fireEvent.change(ta, { target: { value: 'cannot persist this' } });
    await waitFor(() => expect(updateMemoryMock).not.toHaveBeenCalled());
    expect(deleteMemoryMock).not.toHaveBeenCalled();
  });
});
