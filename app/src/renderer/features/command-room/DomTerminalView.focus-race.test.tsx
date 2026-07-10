// @vitest-environment jsdom
// Repro: "pane needs multiple clicks to focus" (operator report 2026-07-10).
//
// #182 fixed the micro-selection swallow, but the mouseup stand-down gate
// re-reads LIVE engine state instead of remembering whether the native
// mousedown handler actually focused THIS click:
//
//   onMouseDownNative: trackingActive() = !ptyExited && mode!=='none' && sgr
//                      → only then focus()
//   onMouseUp (React): if (mt.mode !== 'none' && mt.sgr) return  ← re-read!
//
// Any state change between press and release (busy TUI writing DECSET mid-
// click, or a pane whose PTY died with tracking flags latched on) makes the
// two gates disagree → the click focuses NOTHING. Same defect class as the
// check/claim async-gap: the claim must ride the check from ONE moment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const rpcMock = vi.hoisted(() => ({
  pty: {
    snapshot: vi.fn<(sessionId: string) => Promise<{ buffer: string }>>(() =>
      Promise.resolve({ buffer: '' }),
    ),
    write: vi.fn<(sessionId: string, data: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    resize: vi.fn<(sessionId: string, cols: number, rows: number) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  },
}));
vi.mock('@/renderer/lib/rpc', () => ({ rpc: rpcMock, rpcSilent: rpcMock }));
vi.mock('@/renderer/lib/pty-data-bus', () => ({ subscribePtyData: () => () => undefined }));
vi.mock('@/renderer/lib/pty-exit-bus', () => ({ subscribeExit: () => () => undefined }));
vi.mock('@/renderer/lib/pane-prompt-capture', () => ({
  feedPromptKey: vi.fn(),
  feedPromptPaste: vi.fn(),
}));
vi.mock('./route-link-click', () => ({ routeLinkClick: vi.fn() }));
vi.mock('@/renderer/features/right-rail/RightRailContext.data', () => ({
  useRightRail: () => ({ activeTab: 'browser', setActiveTab: vi.fn() }),
}));
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (selector: (s: unknown) => unknown) =>
    selector({ activeWorkspace: { id: 'ws-1' }, sessions: [] }),
}));

import { __resetEngineCache, getCachedEngine } from '@/renderer/lib/engine-cache';
import { DomTerminalView } from './DomTerminalView';

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', ROStub);
});
afterEach(() => {
  cleanup();
  __resetEngineCache();
  vi.unstubAllGlobals();
});

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe('pane click→focus stand-down races (multi-click bug)', () => {
  it('focuses when mouse tracking turns ON between press and release (busy-TUI flap)', async () => {
    const { container } = render(<DomTerminalView sessionId="race1" />);
    await settle();
    const entry = getCachedEngine('race1')!;
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    const input = container.querySelector('textarea')!;

    // Press while tracking is OFF → native press handler stands down, no focus.
    expect(entry.engine.mouseTracking.mode).toBe('none');
    fireEvent.mouseDown(view, { button: 0 });
    expect(document.activeElement).not.toBe(input); // premise: press did NOT focus

    // Busy TUI enables tracking mid-click (alt-screen + DECSET 1000;1006).
    await new Promise<void>((r) => entry.engine.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h', () => r()));
    expect(entry.engine.mouseTracking).toEqual({ mode: 'vt200', sgr: true });

    // Release: the gate re-reads live state, believes "mousedown focused", returns.
    fireEvent.mouseUp(view, { button: 0 });
    expect(document.activeElement).toBe(input); // FAILS pre-fix: click swallowed
  });

  it('focuses a pane whose PTY exited with tracking flags latched on (dead-pane lockout)', async () => {
    const { container } = render(<DomTerminalView sessionId="race2" />);
    await settle();
    const entry = getCachedEngine('race2')!;
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    const input = container.querySelector('textarea')!;

    await new Promise<void>((r) => entry.engine.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h', () => r()));
    entry.ptyExited = true; // TUI died mid-fullscreen; DECRST never arrived

    // Press: trackingActive() requires !ptyExited → no native focus.
    fireEvent.mouseDown(view, { button: 0 });
    expect(document.activeElement).not.toBe(input);
    // Release: stand-down gate does NOT check ptyExited → returns → never focusable.
    fireEvent.mouseUp(view, { button: 0 });
    expect(document.activeElement).toBe(input); // FAILS pre-fix: pane unfocusable by click
  });
});
