// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #5 — JorvisRoom render isolation. Uses the REAL
// AppStateProvider (the sibling JorvisRoom.test.tsx mocks the state module,
// so it cannot catch a broad-subscription regression). The broad
// useAppState() reads — in the room AND in useJorvisConversations — used to
// re-render the whole transcript subtree on every global dispatch.
// Probe: JorvisRoom calls useJorvisPaneEvents exactly once per render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, type Dispatch } from 'react';

const paneEventsMock = vi.hoisted(() => vi.fn(() => []));
vi.mock('./use-jorvis-pane-events', () => ({
  useJorvisPaneEvents: paneEventsMock,
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
    assistant: { send: vi.fn() },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    ruflo: {
      health: vi.fn().mockResolvedValue({ state: 'absent' }),
      'patterns.search': vi.fn().mockResolvedValue({ ok: true, results: [] }),
      'patterns.store': vi.fn().mockResolvedValue({ ok: true }),
    },
  },
  onEvent: vi.fn(() => () => undefined),
}));

vi.mock('@/renderer/lib/voice', () => ({
  isVoiceSupported: () => false,
  startCapture: vi.fn(),
  VoiceBusyError: class VoiceBusyError extends Error {},
}));
vi.mock('@/renderer/lib/notifications', () => ({ playDing: vi.fn() }));
vi.mock('@/renderer/lib/canDo', () => ({ useCanDo: () => false }));

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { JorvisRoom } from './JorvisRoom';
import type { Workspace } from '@/shared/types';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'SigmaLink',
  rootPath: '/tmp/sigmalink',
  repoRoot: '/tmp/sigmalink',
  repoMode: 'git',
  createdAt: 1,
  lastOpenedAt: 1,
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

describe('JorvisRoom render isolation (perf audit #5)', () => {
  it('does NOT re-render on an unrelated global dispatch', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <JorvisRoom />
      </AppStateProvider>,
    );
    // Activate a workspace so the full (non-empty) branch renders, then let
    // the conversation-hydration microtasks settle.
    await act(async () => {
      dispatchRef.current!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {});
    const before = paneEventsMock.mock.calls.length;
    await act(async () => {
      dispatchRef.current!({ type: 'SET_ROOM', room: 'swarm' });
    });
    // `room` is not part of JorvisRoom's (or useJorvisConversations')
    // subscription → no re-render.
    expect(paneEventsMock.mock.calls.length).toBe(before);
  });

  it('control: DOES re-render when the active workspace changes', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <JorvisRoom />
      </AppStateProvider>,
    );
    await act(async () => {
      dispatchRef.current!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {});
    const before = paneEventsMock.mock.calls.length;
    await act(async () => {
      dispatchRef.current!({
        type: 'WORKSPACE_OPEN',
        workspace: { ...workspace, id: 'ws-2', name: 'Other' },
      });
    });
    expect(paneEventsMock.mock.calls.length).toBeGreaterThan(before);
  });
});
