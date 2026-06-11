// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const rpcMock = vi.hoisted(() => ({
  pty: {
    snapshot: vi.fn(async (_sessionId: string) => ({ buffer: '' })),
    write: vi.fn(async (_sessionId: string, _data: string) => undefined),
    resize: vi.fn(async (_sessionId: string, _cols: number, _rows: number) => undefined),
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
});
