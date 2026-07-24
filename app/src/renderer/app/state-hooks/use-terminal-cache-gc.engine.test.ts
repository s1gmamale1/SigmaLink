// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AgentSession } from '@/shared/types';
import type { AppState } from '../state.types';
import { initialAppState } from '../state.types';
import { useTerminalCacheGc } from './use-terminal-cache-gc';
import {
  __resetEngineCache,
  getCachedEngine,
  getOrCreateEngine,
} from '@/renderer/lib/engine-cache';
import { __resetPtyDataBus } from '@/renderer/lib/pty-data-bus';
import { __resetPtyExitBus } from '@/renderer/lib/pty-exit-bus';
import {
  __resetScratchTabs,
  addScratchTab,
  closeScratchTab,
} from '@/renderer/lib/scratch-tabs';

function session(id: string): AgentSession {
  return {
    id,
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/tmp',
    branch: null,
    status: 'running',
    startedAt: 1,
    worktreePath: null,
  };
}

function stateWith(sessions: AgentSession[]): AppState {
  return {
    ...initialAppState,
    ready: true,
    sessions,
    sessionsByWorkspace: { 'ws-1': sessions },
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'sigma', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => ({
        ok: true,
        data: channel === 'pty.snapshot' ? { buffer: '' } : undefined,
      })),
      eventOn: vi.fn(() => () => undefined),
    } as unknown as Window['sigma'],
  });
});

afterEach(() => {
  __resetEngineCache();
  __resetPtyDataBus();
  __resetPtyExitBus();
  __resetScratchTabs();
});

describe('scratch terminal cleanup — DOM engine ownership', () => {
  it('disposes the real cached engine when a scratch tab closes', () => {
    getOrCreateEngine('scratch-dom');
    addScratchTab('parent', 'scratch-dom');

    closeScratchTab('parent', 'scratch-dom');

    expect(getCachedEngine('scratch-dom')).toBeUndefined();
  });
});

describe('useTerminalCacheGc — DOM engine ownership', () => {
  it('disposes the real cached engine when a session permanently disappears', () => {
    const gone = session('dom-gone');
    getOrCreateEngine(gone.id);
    expect(getCachedEngine(gone.id)).toBeTruthy();

    const { rerender } = renderHook(({ state }: { state: AppState }) => useTerminalCacheGc(state), {
      initialProps: { state: stateWith([gone]) },
    });
    rerender({ state: stateWith([]) });

    expect(getCachedEngine(gone.id)).toBeUndefined();
  });
});
