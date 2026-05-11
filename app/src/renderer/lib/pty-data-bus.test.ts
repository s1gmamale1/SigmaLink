// V1.1.8 perf-ptybus — coverage for the renderer-side ptyDataBus.
//
// Scope:
//   - sessionId routing (multi-subscriber same id, no cross-session leakage)
//   - unsubscribe semantics
//   - single global `eventOn` registration regardless of subscriber churn
//   - `__resetPtyDataBus` test helper restores a clean slate
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
  // Attach to the global window — vitest provides a happy-dom-ish shim if the
  // test file opts into jsdom, but we don't need a DOM here. A bare object is
  // enough because the bus only touches `window.sigma.eventOn`.
  (globalThis as unknown as { window?: { sigma: unknown } }).window = {
    sigma: { eventOn },
  };
  return { eventOn, emit, offSpy };
}

let stub: SigmaStub;

beforeEach(async () => {
  stub = installSigmaStub();
  // Reset state between tests — the bus is a module-level singleton so this
  // is non-negotiable.
  const mod = await import('./pty-data-bus');
  mod.__resetPtyDataBus();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('ptyDataBus', () => {
  it('routes a chunk to a subscriber registered for the matching sessionId', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const fn = vi.fn();
    subscribePtyData('sess-A', fn);

    stub.emit('pty:data', { sessionId: 'sess-A', data: 'hello' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ sessionId: 'sess-A', data: 'hello' });
  });

  it('fans out to multiple subscribers for the same sessionId', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const a = vi.fn();
    const b = vi.fn();
    subscribePtyData('sess-A', a);
    subscribePtyData('sess-A', b);

    stub.emit('pty:data', { sessionId: 'sess-A', data: 'x' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does NOT deliver a sess-B payload to a sess-A subscriber', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const a = vi.fn();
    const b = vi.fn();
    subscribePtyData('sess-A', a);
    subscribePtyData('sess-B', b);

    stub.emit('pty:data', { sessionId: 'sess-B', data: 'only-b' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after the returned unsubscribe is invoked', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const fn = vi.fn();
    const off = subscribePtyData('sess-A', fn);

    stub.emit('pty:data', { sessionId: 'sess-A', data: '1' });
    off();
    stub.emit('pty:data', { sessionId: 'sess-A', data: '2' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('registers `eventOn` exactly once regardless of subscribe churn', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');

    // 5 subscribes + 5 unsubscribes across 3 distinct sessions
    const offs = [
      subscribePtyData('a', () => undefined),
      subscribePtyData('b', () => undefined),
      subscribePtyData('a', () => undefined),
      subscribePtyData('c', () => undefined),
      subscribePtyData('b', () => undefined),
    ];
    offs.forEach((off) => off());
    // Re-subscribe after dropping to zero — bus must not re-register.
    subscribePtyData('a', () => undefined);

    expect(stub.eventOn).toHaveBeenCalledTimes(1);
    expect(stub.eventOn).toHaveBeenCalledWith('pty:data', expect.any(Function));
  });

  it('drops payloads that fail the shape guard', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const fn = vi.fn();
    subscribePtyData('sess-A', fn);

    // Malformed payloads from a hypothetical misbehaving main process.
    stub.emit('pty:data', null);
    stub.emit('pty:data', { sessionId: 'sess-A' }); // missing data
    stub.emit('pty:data', { data: 'x' }); // missing sessionId
    stub.emit('pty:data', { sessionId: 42, data: 'x' }); // wrong type
    expect(fn).not.toHaveBeenCalled();

    // Sanity check — a well-formed payload still flows.
    stub.emit('pty:data', { sessionId: 'sess-A', data: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('drops cleanly when the last subscriber for a sessionId unsubscribes', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const fn = vi.fn();
    const off = subscribePtyData('sess-A', fn);
    off();
    // A subsequent payload for the same id must be a no-op (no internal map
    // entry left dangling). We can't introspect the Map, but observing that
    // no callback fires and no error throws is the contract.
    expect(() => stub.emit('pty:data', { sessionId: 'sess-A', data: 'x' })).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('handles a subscriber that synchronously unsubscribes itself during dispatch', async () => {
    const { subscribePtyData } = await import('./pty-data-bus');
    const calls: string[] = [];
    const offA = subscribePtyData('sess-A', () => {
      calls.push('a');
      offA();
    });
    subscribePtyData('sess-A', () => {
      calls.push('b');
    });

    // The bus snapshots subscribers before iteration, so both fire on the
    // first chunk even though `a` removed itself mid-dispatch.
    stub.emit('pty:data', { sessionId: 'sess-A', data: '1' });
    expect(calls).toEqual(['a', 'b']);

    // After self-unsubscribe, only `b` should receive subsequent chunks.
    stub.emit('pty:data', { sessionId: 'sess-A', data: '2' });
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('__resetPtyDataBus clears state and disposes the global listener', async () => {
    const { subscribePtyData, __resetPtyDataBus } = await import('./pty-data-bus');
    const fn = vi.fn();
    subscribePtyData('sess-A', fn);
    expect(stub.eventOn).toHaveBeenCalledTimes(1);

    __resetPtyDataBus();
    expect(stub.offSpy).toHaveBeenCalledWith('pty:data');

    // After reset, subscribing again must reinstall the listener.
    subscribePtyData('sess-A', fn);
    expect(stub.eventOn).toHaveBeenCalledTimes(2);
  });
});
