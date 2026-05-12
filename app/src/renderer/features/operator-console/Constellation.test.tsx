// @vitest-environment jsdom
//
// V1.1.10 perf — Constellation visibility gate. The force-directed canvas
// previously kept ticking even when the window was hidden or the canvas was
// scrolled off-screen. These tests assert the rAF loop pauses when either
// the Page Visibility API reports hidden OR IntersectionObserver reports the
// canvas is out of view.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Constellation } from './Constellation';
import type { SwarmAgent } from '@/shared/types';

// Minimal canvas 2d-context shim — Constellation only calls these methods,
// and jsdom does not implement them. We don't assert what was drawn; the
// tests only care whether the rAF tick fired.
function installCanvasShim(): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext?: () => Record<string, unknown>;
  };
  proto.getContext = () => ({
    clearRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    fillText: () => undefined,
    setTransform: () => undefined,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  });
}

// Capture IntersectionObserver instances so tests can fire entries on demand.
interface MockedIO {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}

function installIntersectionObserverMock(): { observers: MockedIO[] } {
  const observers: MockedIO[] = [];
  class MockIO {
    private readonly entry: MockedIO;
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { callback: cb, observed: [], disconnected: false };
      observers.push(this.entry);
    }
    observe(el: Element): void {
      this.entry.observed.push(el);
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      this.entry.disconnected = true;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
  return { observers };
}

function fireIntersection(observer: MockedIO, isIntersecting: boolean): void {
  const entries = observer.observed.map(
    (target) =>
      ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      }) as IntersectionObserverEntry,
  );
  observer.callback(entries, {} as IntersectionObserver);
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function agent(role: SwarmAgent['role'], roleIndex: number): SwarmAgent {
  return {
    id: `${role}-${roleIndex}`,
    swarmId: 'swarm-1',
    role,
    roleIndex,
    providerId: 'claude',
    sessionId: null,
    status: 'idle',
    inboxPath: '',
    agentKey: `${role}-${roleIndex}`,
  };
}

let rafSpy: ReturnType<typeof vi.spyOn>;
let cancelSpy: ReturnType<typeof vi.spyOn>;
let ioMock: { observers: MockedIO[] };

beforeEach(() => {
  installCanvasShim();
  ioMock = installIntersectionObserverMock();

  // ResizeObserver isn't shipped in jsdom — Constellation uses it but we
  // don't care about resize behavior here.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {
        /* no-op */
      }
      unobserve(): void {
        /* no-op */
      }
      disconnect(): void {
        /* no-op */
      }
    } as unknown as typeof ResizeObserver;
  }

  setDocumentHidden(false);

  // Spy on rAF/cancelAF on the window so we can assert calls. We let rAF
  // actually schedule (returning a fake handle) so the loop can request the
  // next tick — but we never advance microtasks for it, which means each
  // test only observes the initial schedule call.
  let nextHandle = 1;
  rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
    return nextHandle++;
  });
  cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  rafSpy.mockRestore();
  cancelSpy.mockRestore();
  setDocumentHidden(false);
});

describe('Constellation visibility gate', () => {
  it('starts the rAF loop when the canvas is visible and the page is visible', () => {
    render(<Constellation swarmId="swarm-1" agents={[agent('coordinator', 0)]} filter="all" />);

    // The IntersectionObserver is installed; its initial state defaults to
    // "in view" inside Constellation until the observer reports otherwise.
    // With `document.hidden = false`, the loop should request the first
    // frame.
    expect(rafSpy).toHaveBeenCalled();
  });

  it('does NOT schedule rAF while document.hidden is true', () => {
    setDocumentHidden(true);
    rafSpy.mockClear();

    render(<Constellation swarmId="swarm-1" agents={[agent('coordinator', 0)]} filter="all" />);

    // Loop should be paused; no rAF scheduled.
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('cancels the rAF loop when the page becomes hidden after start', () => {
    render(<Constellation swarmId="swarm-1" agents={[agent('coordinator', 0)]} filter="all" />);
    expect(rafSpy).toHaveBeenCalled();

    setDocumentHidden(true);

    // The visibility handler should cancel the pending frame.
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('resumes the loop when the page becomes visible again', () => {
    setDocumentHidden(true);
    render(<Constellation swarmId="swarm-1" agents={[agent('coordinator', 0)]} filter="all" />);
    expect(rafSpy).not.toHaveBeenCalled();

    setDocumentHidden(false);

    // After visibilitychange → visible, reconcile() restarts the loop.
    expect(rafSpy).toHaveBeenCalled();
  });

  it('pauses the loop when IntersectionObserver reports out of view', () => {
    render(<Constellation swarmId="swarm-1" agents={[agent('coordinator', 0)]} filter="all" />);
    expect(rafSpy).toHaveBeenCalled();

    // Take the first registered IO and fire isIntersecting=false.
    const observer = ioMock.observers[ioMock.observers.length - 1];
    expect(observer).toBeTruthy();
    fireIntersection(observer, false);

    expect(cancelSpy).toHaveBeenCalled();
  });

  it('disconnects the IntersectionObserver on unmount', () => {
    const { unmount } = render(
      <Constellation swarmId="swarm-1" agents={[agent('coordinator', 0)]} filter="all" />,
    );
    const observer = ioMock.observers[ioMock.observers.length - 1];
    expect(observer.disconnected).toBe(false);

    unmount();

    expect(observer.disconnected).toBe(true);
    expect(cancelSpy).toHaveBeenCalled();
  });
});
