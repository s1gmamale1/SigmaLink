// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { readDir, kv, mutations } = vi.hoisted(() => {
  const readDir = vi.fn(async ({ path }: { path: string }) => {
    if (path.endsWith('/src')) return { entries: [{ name: 'a.ts', type: 'file' as const }] };
    return { entries: [{ name: 'src', type: 'dir' as const }] };
  });
  const kv = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const mutations = {
    createFile: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
    createFolder: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
    rename: vi.fn(async () => '/ws/renamed'),
    move: vi.fn(async () => '/ws/dest/a.ts'),
    trash: vi.fn(async () => true),
  };
  return { readDir, kv, mutations };
});

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { fs: { readDir } },
  rpcSilent: { kv },
}));

vi.mock('./useFileMutations', () => ({ useFileMutations: () => mutations }));

import { FileTree } from './FileTree';

beforeEach(() => vi.clearAllMocks());

function renderTree() {
  return render(
    <FileTree workspaceId="ws1" rootPath="/ws" selectedPath={null} onOpenFile={vi.fn()} />,
  );
}

describe('FileTree mutations', () => {
  it('header "New File" opens the prompt and creates at the root', async () => {
    renderTree();
    fireEvent.click(screen.getByLabelText('New file'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'fresh.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.createFile).toHaveBeenCalledWith('/ws', 'fresh.ts'));
  });

  it('row context menu "Delete" trashes that file', async () => {
    renderTree();
    // Expand "src" to reveal a.ts.
    fireEvent.click(await screen.findByText('src'));
    const fileRow = await screen.findByText('a.ts');
    fireEvent.contextMenu(fileRow);
    // Scope to the portalled menu item by role so the lookup can never match
    // stray "Delete" text elsewhere in the DOM.
    const deleteItem = await within(document.body).findByRole('menuitem', { name: 'Delete' });
    fireEvent.click(deleteItem);
    await waitFor(() => expect(mutations.trash).toHaveBeenCalledWith('/ws/src/a.ts'));
  });
});
