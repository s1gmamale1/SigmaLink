// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #5 — EditorTab render isolation. Real provider; the
// sibling EditorTab.test.tsx mocks the state module so it cannot catch a
// broad-subscription regression. The broad useAppState() read re-rendered
// the whole Monaco host tree on every global dispatch.
// Probe: EditorTab calls useEditor exactly once per render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, type Dispatch } from 'react';

const useEditorMock = vi.hoisted(() =>
  vi.fn(() => ({
    file: null,
    buffer: '',
    setBuffer: vi.fn(),
    dirty: false,
    loading: false,
    error: null,
    open: vi.fn(),
    save: vi.fn(),
  })),
);
vi.mock('./useEditor', () => ({
  useEditor: useEditorMock,
  EDITOR_FOCUS_EVENT: 'editor:focus',
}));
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco" />,
}));
vi.mock('./FileTree', () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => (
    <div data-testid="file-tree" data-root={rootPath} />
  ),
}));
vi.mock('@/renderer/app/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
  },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
  onEvent: vi.fn(() => () => undefined),
}));

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { EditorTab } from './EditorTab';
import type { Workspace } from '@/shared/types';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Test WS',
  rootPath: '/tmp/ws',
  repoRoot: '/tmp/ws',
  repoMode: 'git',
  createdAt: 0,
  lastOpenedAt: 0,
};

// Capture the live dispatch into a module ref. The write happens inside a
// useEffect (not during render) so the react-hooks/globals lint rule — which
// forbids writing module-scope values during render — is satisfied.
const dispatchRef: { current: Dispatch<Action> | null } = { current: null };
function DispatchGrabber() {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('sigma', {
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  appStateStore.setState(initialAppState);
});

describe('EditorTab render isolation (perf audit #5)', () => {
  it('does NOT re-render the Monaco host tree on an unrelated global dispatch', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <EditorTab />
      </AppStateProvider>,
    );
    await act(async () => {
      dispatchRef.current!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {}); // flush kv-hydration microtasks
    const before = useEditorMock.mock.calls.length;
    await act(async () => {
      dispatchRef.current!({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(useEditorMock.mock.calls.length).toBe(before);
  });
});
