// @vitest-environment jsdom
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
});
