// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #6 — RufloReadinessPill render isolation. The pill is
// always-mounted in the breadcrumb; its broad useAppState() context read
// re-rendered it on every global dispatch just to read activeWorkspace.
// Probe: the pill calls cn() per render once a workspace is active.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, type Dispatch } from 'react';

const cnSpy = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return {
    ...actual,
    cn: (...args: Parameters<typeof actual.cn>) => {
      cnSpy.count += 1;
      return actual.cn(...args);
    },
  };
});

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    // Return the workspace so the provider's mount-time READY
    // (reconcileOpenWorkspaces vs the persisted list) does NOT wipe the
    // workspace we open below — otherwise activeWorkspace goes null, the pill
    // renders its empty branch, and cn is never called (the probe can't fire).
    // Inlined (not the `workspace` const) — vi.mock factories are hoisted.
    workspaces: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'ws-1',
          name: 'SigmaLink',
          rootPath: '/tmp/ws',
          repoRoot: '/tmp/ws',
          repoMode: 'git',
          createdAt: 1,
          lastOpenedAt: 1,
        },
      ]),
    },
    skills: { list: vi.fn().mockResolvedValue([]) },
    swarms: { list: vi.fn().mockResolvedValue([]) },
    sessions: { list: vi.fn().mockResolvedValue([]) },
  },
  onEvent: vi.fn(() => () => undefined),
  rpcSilent: {
    ruflo: {
      verifyForWorkspace: vi.fn().mockResolvedValue({
        claude: true,
        codex: true,
        gemini: true,
        kimi: false,
        opencode: false,
        detected: { kimi: false, opencode: false },
        mode: 'fast',
        errors: [],
      }),
    },
    skills: {
      verifyForWorkspace: vi.fn().mockResolvedValue({
        workspaceId: 'ws-1',
        verified: 1,
        refanned: 0,
        errors: [],
      }),
    },
  },
}));

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { RufloReadinessPill } from './RufloReadinessPill';
import type { Workspace } from '@/shared/types';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'SigmaLink',
  rootPath: '/tmp/ws',
  repoRoot: '/tmp/ws',
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
  cnSpy.count = 0;
  vi.stubGlobal('sigma', {
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  appStateStore.setState(initialAppState);
});

describe('RufloReadinessPill render isolation (perf audit #6)', () => {
  it('does NOT re-render on an unrelated global dispatch', async () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <RufloReadinessPill />
      </AppStateProvider>,
    );
    // Activate a workspace and let the verify round-trips settle.
    await act(async () => {
      dispatchRef.current!({ type: 'WORKSPACE_OPEN', workspace });
    });
    await act(async () => {});
    const before = cnSpy.count;
    await act(async () => {
      dispatchRef.current!({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(cnSpy.count).toBe(before);
  });
});
