// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

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

// FlowView link context (P2): the host reads the active workspace + right-rail
// and routes clicked links through the shared routeLinkClick. Mock all three
// so the host renders without a provider tree; the link test asserts the
// route-link-click spy received the url + workspace id.
const routeLinkClickMock = vi.fn();
vi.mock('./route-link-click', () => ({
  routeLinkClick: (...args: unknown[]) => routeLinkClickMock(...args),
}));
const setActiveTabMock = vi.fn();
vi.mock('@/renderer/features/right-rail/RightRailContext.data', () => ({
  useRightRail: () => ({ activeTab: 'browser', setActiveTab: setActiveTabMock }),
}));
const stateMock = vi.hoisted(() => ({
  state: {
    activeWorkspace: { id: 'ws-1' } as { id?: string },
    sessions: [] as Array<{ id: string; providerId: string }>,
  },
}));
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (selector: (s: typeof stateMock.state) => unknown) => selector(stateMock.state),
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
  stateMock.state.sessions = [];
});
afterEach(() => {
  cleanup();
  __resetEngineCache();
  vi.unstubAllGlobals();
});

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe('DomTerminalView', () => {
  it('creates a cached engine and marks it mounted; unmount clears the flag', async () => {
    const { unmount } = render(<DomTerminalView sessionId="d1" />);
    await settle();
    expect(getCachedEngine('d1')?.mounted).toBe(true);
    unmount();
    expect(getCachedEngine('d1')?.mounted).toBe(false);
    expect(getCachedEngine('d1')).toBeTruthy(); // engine survives unmount (cache-owned)
  });

  it('keydown encodes through the InputEncoder to pty.write', async () => {
    const { container } = render(<DomTerminalView sessionId="d2" />);
    await settle();
    const input = container.querySelector('textarea')!;
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(rpcMock.pty.write.mock.calls.map((c) => c[1])).toEqual(['a', '\r', '\x1b[A']);
  });

  it('cmd-combos are NOT swallowed (encoder returns null → host app keeps them)', async () => {
    const { container } = render(<DomTerminalView sessionId="d3" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'c', metaKey: true });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('paste normalizes newlines (bracketed-paste off by default)', async () => {
    const { container } = render(<DomTerminalView sessionId="d4" />);
    await settle();
    fireEvent.paste(container.querySelector('textarea')!, {
      clipboardData: { getData: () => 'one\ntwo\r\nthree' },
    });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('d4', 'one\rtwo\rthree');
  });

  it('sigma:pty-focus for THIS session focuses the input host', async () => {
    const { container } = render(<DomTerminalView sessionId="d5" />);
    await settle();
    const input = container.querySelector('textarea')!;
    window.dispatchEvent(new CustomEvent('sigma:pty-focus', { detail: { sessionId: 'other' } }));
    expect(document.activeElement).not.toBe(input);
    window.dispatchEvent(new CustomEvent('sigma:pty-focus', { detail: { sessionId: 'd5' } }));
    expect(document.activeElement).toBe(input);
  });

  it('keystrokes are dropped once the PTY exited', async () => {
    const { container } = render(<DomTerminalView sessionId="d6" />);
    await settle();
    getCachedEngine('d6')!.ptyExited = true;
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'a' });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('alt-screen: wheel converts to arrow-key bytes (TUI-owned scrollback)', async () => {
    const { container } = render(<DomTerminalView sessionId="d9" />);
    await settle();
    const engine = getCachedEngine('d9')!.engine;
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h', () => r()));
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.wheel(view, { deltaY: 51, deltaMode: 0 }); // ≈3 lines of pixels
    fireEvent.wheel(view, { deltaY: -17, deltaMode: 0 }); // ≈1 line up
    const sent = rpcMock.pty.write.mock.calls.map((c) => c[1]).join('');
    expect(sent).toContain('\x1b[B');
    expect(sent).toContain('\x1b[A');
    // DECCKM flips the encoding to SS3 — the encoder owns that mapping.
    rpcMock.pty.write.mockClear();
    await new Promise<void>((r) => engine.term.write('\x1b[?1h', () => r()));
    fireEvent.wheel(view, { deltaY: 17, deltaMode: 0 });
    expect(rpcMock.pty.write.mock.calls.map((c) => c[1]).join('')).toContain('\x1bOB');
  });

  it('mouse-tracking apps (claude fullscreen) get SGR wheel REPORTS, not arrows', async () => {
    const { container } = render(<DomTerminalView sessionId="d11" />);
    await settle();
    const engine = getCachedEngine('d11')!.engine;
    // claude-fullscreen style: alt screen + vt200 tracking + SGR encoding
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h', () => r()));
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.wheel(view, { deltaY: -17, deltaMode: 0 }); // one tick up
    const sent = rpcMock.pty.write.mock.calls.map((c) => c[1]).join('');
    expect(sent).toContain('\x1b[<64;'); // SGR wheel-up report
    expect(sent.endsWith('M')).toBe(true);
    expect(sent).not.toContain('\x1b[A'); // NEVER arrows — they hit the composer history
    rpcMock.pty.write.mockClear();
    fireEvent.wheel(view, { deltaY: 17, deltaMode: 0 });
    expect(rpcMock.pty.write.mock.calls.map((c) => c[1]).join('')).toContain('\x1b[<65;');
  });

  it('normal buffer: wheel sends NO bytes (native DOM scroll owns it)', async () => {
    const { container } = render(<DomTerminalView sessionId="d10" />);
    await settle();
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.wheel(view, { deltaY: 51, deltaMode: 0 });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('win32: paste keybindings are NOT encoded — the native paste event handles them', async () => {
    const prevSigma = (window as { sigma?: unknown }).sigma;
    (window as { sigma?: unknown }).sigma = { platform: 'win32' };
    try {
      const { container } = render(<DomTerminalView sessionId="d7" />);
      await settle();
      const input = container.querySelector('textarea')!;
      fireEvent.keyDown(input, { key: 'v', ctrlKey: true });
      fireEvent.keyDown(input, { key: 'V', ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(input, { key: 'Insert', shiftKey: true });
      expect(rpcMock.pty.write).not.toHaveBeenCalled();
      // the browser-level paste those keys trigger still flows through onPaste
      fireEvent.paste(input, { clipboardData: { getData: () => 'pasted' } });
      expect(rpcMock.pty.write).toHaveBeenCalledWith('d7', 'pasted');
    } finally {
      (window as { sigma?: unknown }).sigma = prevSigma;
    }
  });

  it('mac (default platform): Ctrl+V stays readline quoted-insert (\\x16)', async () => {
    const { container } = render(<DomTerminalView sessionId="d8" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'v', ctrlKey: true });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('d8', '\x16');
  });

  it('reports SGR press/release when the app tracks the mouse; shift bypasses for selection', async () => {
    const { container } = render(<DomTerminalView sessionId="m1" />);
    await settle();
    const engine = getCachedEngine('m1')!.engine;
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h', () => r()));
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.mouseDown(view, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseUp(view, { button: 0, clientX: 0, clientY: 0 });
    const sent = rpcMock.pty.write.mock.calls.map((c) => c[1]).join('');
    expect(sent).toContain('\x1b[<0;1;1M');
    expect(sent).toContain('\x1b[<0;1;1m');
    rpcMock.pty.write.mockClear();
    fireEvent.mouseDown(view, { button: 0, shiftKey: true });
    expect(rpcMock.pty.write).not.toHaveBeenCalled(); // shift = native selection
  });

  it('drag mode (1002) reports motion only while pressed; cell-deduped', async () => {
    const { container } = render(<DomTerminalView sessionId="m2" />);
    await settle();
    const engine = getCachedEngine('m2')!.engine;
    await new Promise<void>((r) => engine.term.write('\x1b[?1049h\x1b[?1002h\x1b[?1006h', () => r()));
    const view = container.querySelector('[data-testid="dom-terminal-view"]')!;
    fireEvent.mouseMove(view, { clientX: 0, clientY: 0 });
    expect(rpcMock.pty.write).not.toHaveBeenCalled(); // not pressed
    fireEvent.mouseDown(view, { button: 0, clientX: 0, clientY: 0 });
    rpcMock.pty.write.mockClear();
    fireEvent.mouseMove(view, { clientX: 0, clientY: 0 }); // same cell → deduped
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('no tracking → no reports, selection untouched', async () => {
    const { container } = render(<DomTerminalView sessionId="m3" />);
    await settle();
    fireEvent.mouseDown(container.querySelector('[data-testid="dom-terminal-view"]')!, { button: 0 });
    expect(rpcMock.pty.write).not.toHaveBeenCalled();
  });

  it('clicking a FlowView link routes through routeLinkClick with the workspace id', async () => {
    const { container } = render(<DomTerminalView sessionId="m4" />);
    await settle();
    const engine = getCachedEngine('m4')!.engine;
    await act(
      () =>
        new Promise<void>((r) =>
          engine.term.write('open https://a.dev/x now', () => setTimeout(r, 40)),
        ),
    );
    const anchor = container.querySelector('[data-link]') as HTMLElement;
    expect(anchor).toBeTruthy();
    fireEvent.click(anchor);
    expect(routeLinkClickMock).toHaveBeenCalledTimes(1);
    expect(routeLinkClickMock.mock.calls[0][0]).toBe('https://a.dev/x');
    expect(routeLinkClickMock.mock.calls[0][1]).toBe('ws-1');
  });

  it('Cmd+F opens find-in-pane; typing highlights matches; Escape closes + refocuses (P2)', async () => {
    const { container } = render(<DomTerminalView sessionId="m5" />);
    await settle();
    const engine = getCachedEngine('m5')!.engine;
    await act(
      () => new Promise<void>((r) => engine.term.write('hello world hello', () => setTimeout(r, 40))),
    );
    const input = container.querySelector('textarea')!;
    // default platform is darwin → Cmd+F opens the search bar
    fireEvent.keyDown(input, { key: 'f', metaKey: true });
    expect(container.querySelector('[data-testid="pane-search"]')).toBeTruthy();
    // the keystroke must NOT reach the PTY
    expect(rpcMock.pty.write).not.toHaveBeenCalled();

    const searchInput = container.querySelector(
      '[data-testid="pane-search"] input',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'hello' } });
    });
    // FlowView renders a highlight span for the active match
    const flow = container.querySelector('[data-testid="flow-view"]')!;
    expect(flow.querySelector('[data-search-active]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-search-count"]')!.textContent).toBe('1/2');

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(container.querySelector('[data-testid="pane-search"]')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('Ctrl+F alone does NOT open search (stays readline forward-char) (P2)', async () => {
    const { container } = render(<DomTerminalView sessionId="m6" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'f', ctrlKey: true });
    expect(container.querySelector('[data-testid="pane-search"]')).toBeNull();
    // Ctrl+F encodes to \x06 (readline forward-char) and reaches the PTY
    expect(rpcMock.pty.write).toHaveBeenCalledWith('m6', '\x06');
  });

  it('switches FlowView↔GridView on buffer-type transitions', async () => {
    const { container } = render(<DomTerminalView sessionId="d12" />);
    await settle();
    expect(container.querySelector('[data-testid="flow-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="grid-view"]')).toBeNull();
    const engine = getCachedEngine('d12')!.engine;
    await act(
      () => new Promise<void>((r) => engine.term.write('\x1b[?1049h', () => setTimeout(r, 40))),
    );
    expect(container.querySelector('[data-testid="grid-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="flow-view"]')).toBeNull();
    await act(
      () => new Promise<void>((r) => engine.term.write('\x1b[?1049l', () => setTimeout(r, 40))),
    );
    expect(container.querySelector('[data-testid="flow-view"]')).toBeTruthy();
  });

  // 2026-06-17 — PANE-FOCUS REGRESSION GUARD (ROADMAP Phase 18).
  //
  // Bug: a single click needed 3-4 tries to focus a DOM-presenter pane. Root
  // cause: onMouseUp focused the hidden input ONLY when the selection was
  // collapsed and early-returned otherwise — so any click that left a stray
  // micro-selection never focused. Fix: copy-on-select first, then focus
  // UNCONDITIONALLY (non-tracking), with preventScroll to kill the scroll-jump.
  it('focuses the input on click EVEN WHEN a stray selection exists (no 3-4 clicks)', async () => {
    const { container } = render(<DomTerminalView sessionId="f1" />);
    await settle();
    const input = container.querySelector('textarea')!;
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    const getSel = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ isCollapsed: false, toString: () => 'x' } as unknown as Selection);
    try {
      expect(document.activeElement).not.toBe(input);
      fireEvent.mouseUp(container.querySelector('[data-testid="dom-terminal-view"]')!);
      expect(document.activeElement).toBe(input); // focus NOT swallowed by the selection
    } finally {
      getSel.mockRestore();
    }
  });

  it('Shift+Enter sends meta-Enter (ESC CR) for a claude pane', async () => {
    stateMock.state.sessions = [{ id: 'se-claude', providerId: 'claude' }];
    const { container } = render(<DomTerminalView sessionId="se-claude" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'Enter', shiftKey: true });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('se-claude', '\x1b\r');
  });

  it('Shift+Enter sends LF for a codex pane', async () => {
    stateMock.state.sessions = [{ id: 'se-codex', providerId: 'codex' }];
    const { container } = render(<DomTerminalView sessionId="se-codex" />);
    await settle();
    fireEvent.keyDown(container.querySelector('textarea')!, { key: 'Enter', shiftKey: true });
    expect(rpcMock.pty.write).toHaveBeenCalledWith('se-codex', '\n');
  });

  it('focuses with { preventScroll: true } to avoid the scroll-jump flicker', async () => {
    const { container } = render(<DomTerminalView sessionId="f2" />);
    await settle();
    const input = container.querySelector('textarea')!;
    const focusSpy = vi.spyOn(input, 'focus');
    const getSel = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ isCollapsed: true, toString: () => '' } as unknown as Selection);
    try {
      fireEvent.mouseUp(container.querySelector('[data-testid="dom-terminal-view"]')!);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      getSel.mockRestore();
    }
  });
});
