// @vitest-environment jsdom
//
// v1.1.10 — regression coverage for Fix 6 (review refresh churn). Before the
// fix, the review-hydration effect depended on `state.sessions.length`,
// causing `runRefreshOnEvent` to tear down and re-subscribe (plus fire an
// immediate RPC fetch) on every session add/remove. Under rapid session
// churn (multi-pane spawn/teardown) this spammed `rpc.review.list`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentSession, ReviewState } from '@/shared/types';
import type { Action, AppState } from '../state.types';
import { initialAppState } from '../state.types';

type EventCb = (payload: unknown) => void;

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
  emit: (event: string, payload: unknown) => void;
}

function installSigmaStub(): SigmaStub {
  const handlers = new Map<string, Set<EventCb>>();
  const eventOn = vi.fn((event: string, cb: EventCb) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(cb);
    return () => {
      handlers.get(event)?.delete(cb);
    };
  });
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  (globalThis as unknown as { window: { sigma: unknown } }).window = {
    ...(globalThis.window ?? {}),
    sigma: { eventOn, eventSend: vi.fn(), invoke: vi.fn() },
  };
  return { eventOn, emit };
}

// Mock every RPC the hook touches. Only `review.list` is interesting for the
// churn assertion; the rest are no-op resolved promises so the other effects
// (skills/memory/tasks/swarms) settle quietly.
const reviewListMock = vi.fn<(wsId: string) => Promise<ReviewState>>();

function emptyReview(workspaceId: string): ReviewState {
  return { workspaceId, sessions: [] };
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    review: { list: (id: string) => reviewListMock(id) },
    skills: { list: () => Promise.resolve({ skills: [], states: [] }) },
    memory: { list_memories: () => Promise.resolve([]) },
    tasks: { list: () => Promise.resolve([]) },
    swarms: { list: () => Promise.resolve([]) },
  },
}));
vi.mock('../../lib/rpc', () => ({
  rpc: {
    review: { list: (id: string) => reviewListMock(id) },
    skills: { list: () => Promise.resolve({ skills: [], states: [] }) },
    memory: { list_memories: () => Promise.resolve([]) },
    tasks: { list: () => Promise.resolve([]) },
    swarms: { list: () => Promise.resolve([]) },
  },
}));

function session(id: string, status: AgentSession['status'] = 'running'): AgentSession {
  return {
    id,
    workspaceId: 'a',
    providerId: 'claude',
    cwd: '/tmp/a',
    branch: null,
    status,
    startedAt: 1,
    worktreePath: null,
  };
}

function stateWith(sessions: AgentSession[]): AppState {
  const ws = {
    id: 'a',
    name: 'A',
    rootPath: '/tmp/a',
    repoRoot: '/tmp/a',
    repoMode: 'git' as const,
    createdAt: 1,
    lastOpenedAt: 1,
  };
  return {
    ...initialAppState,
    ready: true,
    workspaces: [ws],
    openWorkspaces: [ws],
    activeWorkspaceId: 'a',
    activeWorkspace: ws,
    sessions,
  };
}

let sigma: SigmaStub;
let dispatch: ReturnType<typeof vi.fn<(a: Action) => void>>;

beforeEach(() => {
  sigma = installSigmaStub();
  dispatch = vi.fn();
  reviewListMock.mockReset();
  reviewListMock.mockResolvedValue(emptyReview('a'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderLiveEvents(state: AppState) {
  const { useLiveEvents } = await import('./use-live-events');
  return renderHook((props: { state: AppState }) => useLiveEvents(props.state, dispatch), {
    initialProps: { state },
  });
}

describe('useLiveEvents — Fix 6: review refresh churn on session add/remove', () => {
  it('does NOT refetch review state when sessions change but workspace stays', async () => {
    const initialState = stateWith([session('s1')]);
    const { rerender } = await renderLiveEvents(initialState);
    // Allow the initial fetch to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reviewListMock).toHaveBeenCalledTimes(1);

    // Sessions churn rapidly — add three, remove one. Pre-v1.1.10 every
    // rerender triggered a teardown+resubscribe+immediate refetch.
    rerender({ state: stateWith([session('s1'), session('s2')]) });
    rerender({ state: stateWith([session('s1'), session('s2'), session('s3')]) });
    rerender({ state: stateWith([session('s2'), session('s3')]) });

    await act(async () => {
      await Promise.resolve();
    });

    // No new RPC calls — the effect's dep array no longer includes
    // `sessions.length`, so it doesn't re-run on session churn.
    expect(reviewListMock).toHaveBeenCalledTimes(1);
  });

  it('still refreshes review state when the review:changed event fires', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reviewListMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      sigma.emit('review:changed', { workspaceId: 'a' });
      await Promise.resolve();
    });

    expect(reviewListMock).toHaveBeenCalledTimes(2);
  });
});
