// PERF-9 — coverage for the renderer-side ptyExitBus.
//
// Mirrors pty-data-bus.test.ts:
//   - sessionId routing (multi-subscriber same id, no cross-session leakage)
//   - unsubscribe semantics
//   - single global `eventOn` registration regardless of subscriber churn
//   - exitCode normalization (non-number → -1)
//   - `__resetPtyExitBus` test helper restores a clean slate
//
// We stub `window.sigma.eventOn` directly so the bus's install-once path can
// be observed. The real preload bridge isn't available in vitest (node env),
// so the stub also doubles as the renderer-side contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EventCb = (payload: unknown) => void;

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
  emit: (event: string, payload: unknown) => void;
  offSpy: ReturnType<typeof vi.fn>;
}

function installSigmaStub(): SigmaStub {
  const handlers = new Map<string, Set<EventCb>>();
  const offSpy = vi.fn();
  const eventOn = vi.fn((event: string, cb: EventCb) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(cb);
    return () => {
      offSpy(event);
      handlers.get(event)?.delete(cb);
    };
  });
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  (globalThis as unknown as { window?: { sigma: unknown } }).window = {
    sigma: { eventOn },
  };
  return { eventOn, emit, offSpy };
}

let stub: SigmaStub;

beforeEach(async () => {
  stub = installSigmaStub();
  // Reset state between tests — the bus is a module-level singleton.
  const mod = await import('./pty-exit-bus');
  mod.__resetPtyExitBus();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('ptyExitBus', () => {
  it('routes an exit to a subscriber registered for the matching sessionId', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const fn = vi.fn();
    subscribeExit('sess-A', fn);

    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ sessionId: 'sess-A', exitCode: 0 });
  });

  it('only the matching subscriber fires — no cross-session leakage', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const a = vi.fn();
    const b = vi.fn();
    subscribeExit('sess-A', a);
    subscribeExit('sess-B', b);

    stub.emit('pty:exit', { sessionId: 'sess-B', exitCode: 137 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith({ sessionId: 'sess-B', exitCode: 137 });
  });

  it('fans out to multiple subscribers for the same sessionId', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const a = vi.fn();
    const b = vi.fn();
    subscribeExit('sess-A', a);
    subscribeExit('sess-A', b);

    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('normalizes a missing/non-number exitCode to -1', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const fn = vi.fn();
    subscribeExit('sess-A', fn);

    stub.emit('pty:exit', { sessionId: 'sess-A' }); // no exitCode
    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 'nope' }); // wrong type
    expect(fn).toHaveBeenNthCalledWith(1, { sessionId: 'sess-A', exitCode: -1 });
    expect(fn).toHaveBeenNthCalledWith(2, { sessionId: 'sess-A', exitCode: -1 });
  });

  it('stops delivering after the returned unsubscribe is invoked', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const fn = vi.fn();
    const off = subscribeExit('sess-A', fn);

    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 0 });
    off();
    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('registers `eventOn` exactly once regardless of subscribe churn', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');

    const offs = [
      subscribeExit('a', () => undefined),
      subscribeExit('b', () => undefined),
      subscribeExit('a', () => undefined),
      subscribeExit('c', () => undefined),
      subscribeExit('b', () => undefined),
    ];
    offs.forEach((off) => off());
    // Re-subscribe after dropping to zero — bus must not re-register.
    subscribeExit('a', () => undefined);

    expect(stub.eventOn).toHaveBeenCalledTimes(1);
    expect(stub.eventOn).toHaveBeenCalledWith('pty:exit', expect.any(Function));
  });

  it('drops payloads that fail the shape guard', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const fn = vi.fn();
    subscribeExit('sess-A', fn);

    stub.emit('pty:exit', null);
    stub.emit('pty:exit', { exitCode: 0 }); // missing sessionId
    stub.emit('pty:exit', { sessionId: 42, exitCode: 0 }); // wrong type
    expect(fn).not.toHaveBeenCalled();

    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('handles a subscriber that synchronously unsubscribes itself during dispatch', async () => {
    const { subscribeExit } = await import('./pty-exit-bus');
    const calls: string[] = [];
    const offA = subscribeExit('sess-A', () => {
      calls.push('a');
      offA();
    });
    subscribeExit('sess-A', () => {
      calls.push('b');
    });

    // The bus snapshots subscribers before iteration, so both fire on the
    // first exit even though `a` removed itself mid-dispatch.
    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 0 });
    expect(calls).toEqual(['a', 'b']);

    stub.emit('pty:exit', { sessionId: 'sess-A', exitCode: 0 });
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('__resetPtyExitBus clears state and disposes the global listener', async () => {
    const { subscribeExit, __resetPtyExitBus } = await import('./pty-exit-bus');
    const fn = vi.fn();
    subscribeExit('sess-A', fn);
    expect(stub.eventOn).toHaveBeenCalledTimes(1);

    __resetPtyExitBus();
    expect(stub.offSpy).toHaveBeenCalledWith('pty:exit');

    // After reset, subscribing again must reinstall the listener.
    subscribeExit('sess-A', fn);
    expect(stub.eventOn).toHaveBeenCalledTimes(2);
  });
});
