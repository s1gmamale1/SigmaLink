// @vitest-environment jsdom
//
// B3 — composer-gating regression guards for the Jorvis assistant.
//
// ROOT CAUSE (operator-confirmed): the assistant produced TOTAL SILENCE on
// send — not even the user's own bubble rendered, and the Orb never animated.
// `Composer.commit()` guards `if (!trimmed || busy) return`, so the only
// explanation is that `busy` was already TRUE at send time. `busy` is only set
// true by `sendPrompt`, and the ONLY clearing path was an `assistant:state`
// event with `state === 'standby'` whose `conversationId` matched. A turn that
// hung (e.g. `claude` blocking on an interactive trust prompt in dev → no
// envelopes → no standby) latched `busy=true` forever, and every subsequent
// send silently no-opped.
//
// The fix:
//   1. busy/orb only react to events for the turn THIS room started this
//      session (matched by turnId), so a stale/boot/cross-conversation event
//      can't latch the gate.
//   2. A renderer per-turn watchdog resets busy + Orb if no standby arrives.
//
// These tests assert:
//   A. At rest the composer textarea is ENABLED and a send dispatches through
//      to the backend + renders the user's own bubble.
//   B. A normal turn that reaches standby clears busy (the working path).
//   C. A stuck/never-standby turn is cleared by the watchdog so the composer
//      becomes usable again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workspace } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  send: vi.fn(),
  kvGet: vi.fn(),
  kvSet: vi.fn(),
}));

const workspace = vi.hoisted<Workspace>(() => ({
  id: 'workspace-1',
  name: 'SigmaLink',
  rootPath: '/tmp/sigmalink',
  repoRoot: '/tmp/sigmalink',
  repoMode: 'git',
  createdAt: 1,
  lastOpenedAt: 1,
}));

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { activeWorkspace: workspace, workspaces: [workspace] },
    dispatch: mocks.dispatch,
  }),
  useAppDispatch: () => mocks.dispatch,
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: workspace, workspaces: [workspace] }),
}));

// A controllable event bus so the test can emit `assistant:state` events.
type EventCb = (payload: unknown) => void;
const handlers = new Map<string, Set<EventCb>>();
function emitEvent(name: string, payload: unknown): void {
  handlers.get(name)?.forEach((fn) => fn(payload));
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    assistant: { send: mocks.send },
    kv: { get: mocks.kvGet, set: mocks.kvSet },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    ruflo: {
      health: vi.fn().mockResolvedValue({ state: 'absent' }),
      'patterns.search': vi.fn().mockResolvedValue({ ok: true, results: [] }),
      'patterns.store': vi.fn().mockResolvedValue({ ok: true }),
    },
  },
  onEvent: (name: string, cb: EventCb) => {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(cb);
    return () => {
      handlers.get(name)?.delete(cb);
    };
  },
}));

vi.mock('@/renderer/lib/voice', () => ({
  isVoiceSupported: () => false,
  startCapture: vi.fn(),
  VoiceBusyError: class VoiceBusyError extends Error {},
}));

vi.mock('@/renderer/lib/notifications', () => ({ playDing: vi.fn() }));
vi.mock('@/renderer/lib/canDo', () => ({ useCanDo: () => false }));

import { JorvisRoom } from './JorvisRoom';

// A sigma preload stub — the conversations hook hydrates through it. Returning
// an empty conversation list keeps the room at rest with conversationId=null,
// which is exactly the "fresh room" state where the old bug would have left
// `busy` latched from a prior hung turn.
function installSigma() {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'assistant.conversations.list') return { ok: true, data: [] };
    return { ok: true, data: null };
  });
  Object.defineProperty(window, 'sigma', {
    configurable: true,
    value: { invoke, eventOn: vi.fn(() => vi.fn()) },
  });
  return invoke;
}

function getComposer(): HTMLTextAreaElement {
  return screen.getByLabelText('Ask Jorvis') as HTMLTextAreaElement;
}

describe('<JorvisRoom /> B3 — composer is never gated at rest', () => {
  beforeEach(() => {
    handlers.clear();
    mocks.dispatch.mockReset();
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ conversationId: 'conversation-1', turnId: 'turn-1' });
    mocks.kvGet.mockReset();
    mocks.kvGet.mockResolvedValue(null);
    mocks.kvSet.mockReset();
    mocks.kvSet.mockResolvedValue(undefined);
    installSigma();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('A — at rest the composer is enabled and a send dispatches + renders the user bubble', async () => {
    render(<JorvisRoom variant="standalone" />);

    const composer = getComposer();
    // The composer must be usable from a cold start.
    expect(composer.disabled).toBe(false);

    // Let the initial conversation-list hydration settle (it resets messages
    // for an empty list); sending before that would race the optimistic bubble.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(composer, { target: { value: 'launch a pane' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });

    // The send reached the backend (Composer.commit was NOT gated).
    await waitFor(() => {
      expect(mocks.send).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        conversationId: undefined,
        prompt: 'launch a pane',
      });
    });
    // The user's own bubble rendered synchronously (the operator's symptom).
    expect(await screen.findByText('launch a pane')).toBeTruthy();
  });

  it('B — a normal turn that reaches standby clears busy (working path preserved)', async () => {
    render(<JorvisRoom variant="standalone" />);

    const composer = getComposer();
    fireEvent.change(composer, { target: { value: 'first message' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    // While in-flight the composer is gated (busy).
    await waitFor(() => expect(getComposer().disabled).toBe(true));

    // Backend streams a reply and reaches standby for THIS turn.
    act(() => {
      emitEvent('assistant:state', {
        kind: 'delta',
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
        delta: 'hello back',
      });
      emitEvent('assistant:state', {
        kind: 'state',
        state: 'standby',
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        messageId: 'msg-1',
      });
    });

    // busy cleared → composer re-enabled, and a second send goes through.
    await waitFor(() => expect(getComposer().disabled).toBe(false));
    mocks.send.mockResolvedValueOnce({ conversationId: 'conversation-1', turnId: 'turn-2' });
    const composer2 = getComposer();
    fireEvent.change(composer2, { target: { value: 'second message' } });
    fireEvent.keyDown(composer2, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  });

  it('C — a stuck (never-standby) turn is cleared by the watchdog so the composer recovers', async () => {
    vi.useFakeTimers();
    render(<JorvisRoom variant="standalone" />);

    const composer = getComposer();
    fireEvent.change(composer, { target: { value: 'this turn will hang' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });

    // Let the async sendPrompt body settle (send resolves, turnId recorded).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // In-flight → composer gated.
    expect(getComposer().disabled).toBe(true);

    // No standby ever arrives. Advance past the watchdog window (120s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_001);
    });

    // The watchdog self-healed: the composer is usable again.
    expect(getComposer().disabled).toBe(false);
  });

  it('D — a stale event for a DIFFERENT turn never gates the at-rest composer', async () => {
    render(<JorvisRoom variant="standalone" />);

    // Simulate a replayed/boot/cross-conversation state event landing before
    // the user has sent anything. The room has no active turn, so it must be
    // ignored — the composer stays enabled.
    act(() => {
      emitEvent('assistant:state', {
        kind: 'state',
        state: 'thinking',
        conversationId: 'some-other-conversation',
        turnId: 'stale-turn-from-before-reload',
      });
    });

    expect(getComposer().disabled).toBe(false);
    // And a real send still works.
    const composer = getComposer();
    fireEvent.change(composer, { target: { value: 'still works' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  });
});
