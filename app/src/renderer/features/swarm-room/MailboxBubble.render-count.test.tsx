// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #2 — MailboxBubble render isolation.
// Every message row used to call the broad useAppState() (context read →
// re-renders on EVERY global dispatch) just to read activeWorkspace?.id.
// Probe: MailboxBubble calls cn() several times per render; a wrapped cn
// counts renders without prod instrumentation. Asserts:
//   1. an unrelated dispatch does NOT re-render a mounted bubble
//   2. a parent re-render with the SAME message prop is memo-skipped
//   3. control: a DIFFERENT message prop DOES re-render

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState, type Dispatch } from 'react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
    browser: { openTab: vi.fn().mockResolvedValue(undefined) },
  },
  onEvent: vi.fn(() => () => undefined),
}));

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

import { AppStateProvider, useAppDispatch, type Action } from '@/renderer/app/state';
import { appStateStore } from '@/renderer/app/state.hook';
import { initialAppState } from '@/renderer/app/state.types';
import { MailboxBubble } from './MailboxBubble';
import type { SwarmMessage } from '@/shared/types';

function msg(over: Partial<SwarmMessage> = {}): SwarmMessage {
  return {
    id: 'm-1',
    swarmId: 'sw-1',
    fromAgent: 'coordinator',
    toAgent: '*',
    kind: 'SAY',
    body: 'hello swarm',
    ts: 1_700_000_000_000,
    ...over,
  };
}

let dispatchRef: Dispatch<Action> | null = null;
function DispatchGrabber() {
  dispatchRef = useAppDispatch();
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

describe('MailboxBubble render isolation (perf audit #2)', () => {
  it('does NOT re-render on an unrelated global dispatch', () => {
    render(
      <AppStateProvider>
        <DispatchGrabber />
        <MailboxBubble message={msg()} />
      </AppStateProvider>,
    );
    const before = cnSpy.count;
    act(() => {
      dispatchRef!({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(cnSpy.count).toBe(before);
  });

  it('memo: a parent re-render with the same message prop does not re-render the bubble', () => {
    let bump: (() => void) | null = null;
    function Host({ message }: { message: SwarmMessage }) {
      const [, set] = useState(0);
      bump = () => set((n) => n + 1);
      return <MailboxBubble message={message} />;
    }
    const stable = msg();
    render(
      <AppStateProvider>
        <Host message={stable} />
      </AppStateProvider>,
    );
    const before = cnSpy.count;
    act(() => bump!());
    expect(cnSpy.count).toBe(before);
  });

  it('control: a different message prop DOES re-render the bubble', () => {
    const { rerender } = render(
      <AppStateProvider>
        <MailboxBubble message={msg()} />
      </AppStateProvider>,
    );
    const before = cnSpy.count;
    rerender(
      <AppStateProvider>
        <MailboxBubble message={msg({ id: 'm-2', body: 'changed' })} />
      </AppStateProvider>,
    );
    expect(cnSpy.count).toBeGreaterThan(before);
  });
});
