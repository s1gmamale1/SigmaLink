// @vitest-environment jsdom
//
// Spec 2026-06-10 (B) — focused unit coverage for the usePaneImageStaging hook
// extracted from PaneShell. Mirrors the staging assertions that previously
// lived inline in PaneShell.test.tsx, but exercises the hook directly through a
// tiny host component so the concern is covered in isolation.
//
// Invariants:
//   1. arrayBufferToBase64 round-trips bytes (chunked, no Buffer).
//   2. isImageCapable reflects the provider gate.
//   3. stageAndInsertImages stages via panes.stageImage + injects the abs @path.
//   4. The capture-phase paste interceptor stages a pasted image on a running
//      image-capable pane (and preventDefault's), and ignores a text paste.
//   5. A pasted image on a NON-image provider is ignored (no stage, no prevent).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { arrayBufferToBase64, usePaneImageStaging } from './usePaneImageStaging';
import type { AgentSession } from '@/shared/types';

const stageImageMock = vi.fn();
const ptyWriteMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: { stageImage: (...args: unknown[]) => stageImageMock(...args) },
    pty: { write: (...args: unknown[]) => ptyWriteMock(...args) },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  stageImageMock.mockReset();
  ptyWriteMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Host component: exposes the hook's return value to the test and renders a
// container the paste interceptor scopes to.
function Host({
  providerId,
  status,
  onReady,
}: {
  providerId: string;
  status: AgentSession['status'];
  onReady?: (api: ReturnType<typeof usePaneImageStaging>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const api = usePaneImageStaging({
    sessionId: 'sess-1',
    providerId,
    status,
    containerRef: ref,
  });
  onReady?.(api);
  return (
    <div ref={ref} data-testid="host">
      <span>pane</span>
    </div>
  );
}

function makeImageFile(name = 'shot.png', type = 'image/png'): File {
  const bytes = new Uint8Array([1, 2, 3]);
  const file = new File([bytes], name, { type });
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) });
  }
  return file;
}

function pasteEvent(items: Array<{ kind: string; type: string; file: File | null }>, target: Node) {
  const e = new Event('paste', { bubbles: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', {
    value: { items: items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file })) },
  });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('arrayBufferToBase64', () => {
  it('round-trips bytes to base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(btoa(String.fromCharCode(0, 1, 2, 254, 255)));
  });

  it('handles a payload larger than the 0x8000 chunk window', () => {
    const big = new Uint8Array(0x8000 + 16).fill(65); // 'A'
    const out = arrayBufferToBase64(big.buffer);
    // Decodes back to the exact byte length (chunking must not drop bytes).
    expect(atob(out).length).toBe(big.length);
  });
});

describe('usePaneImageStaging — isImageCapable gate', () => {
  it('is true for claude and false for shell', () => {
    let claudeApi: ReturnType<typeof usePaneImageStaging> | null = null;
    render(<Host providerId="claude" status="running" onReady={(a) => (claudeApi = a)} />);
    expect(claudeApi!.isImageCapable).toBe(true);

    let shellApi: ReturnType<typeof usePaneImageStaging> | null = null;
    render(<Host providerId="shell" status="running" onReady={(a) => (shellApi = a)} />);
    expect(shellApi!.isImageCapable).toBe(false);
  });
});

describe('usePaneImageStaging — stageAndInsertImages', () => {
  it('stages bytes via panes.stageImage and injects the absolute @path', async () => {
    stageImageMock.mockResolvedValue({ absPath: '/tmp/staged/img.png' });
    let api: ReturnType<typeof usePaneImageStaging> | null = null;
    render(<Host providerId="claude" status="running" onReady={(a) => (api = a)} />);

    await act(async () => {
      await api!.stageAndInsertImages([makeImageFile()]);
    });

    expect(stageImageMock).toHaveBeenCalledWith(expect.objectContaining({ ext: 'png' }));
    // insertMention writes '@<absPath> ' to the PTY for a running pane.
    expect(ptyWriteMock).toHaveBeenCalledWith('sess-1', expect.stringContaining('/tmp/staged/img.png'));
  });
});

describe('usePaneImageStaging — paste interceptor', () => {
  it('stages a pasted image on a running image-capable pane (and prevents default)', async () => {
    stageImageMock.mockResolvedValue({ absPath: '/tmp/staged/clip.png' });
    const { getByTestId } = render(<Host providerId="claude" status="running" />);
    const host = getByTestId('host');

    const evt = pasteEvent([{ kind: 'file', type: 'image/png', file: makeImageFile('clip.png') }], host);
    const prevent = vi.spyOn(evt, 'preventDefault');
    await act(async () => {
      window.dispatchEvent(evt);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(stageImageMock).toHaveBeenCalled());
    expect(prevent).toHaveBeenCalled();
  });

  it('ignores a text-only paste (no stage, no preventDefault)', async () => {
    const { getByTestId } = render(<Host providerId="claude" status="running" />);
    const host = getByTestId('host');

    const evt = pasteEvent([{ kind: 'string', type: 'text/plain', file: null }], host);
    const prevent = vi.spyOn(evt, 'preventDefault');
    await act(async () => {
      window.dispatchEvent(evt);
      await Promise.resolve();
    });

    expect(stageImageMock).not.toHaveBeenCalled();
    expect(prevent).not.toHaveBeenCalled();
  });

  it('ignores a pasted image on a NON-image provider', async () => {
    const { getByTestId } = render(<Host providerId="shell" status="running" />);
    const host = getByTestId('host');

    const evt = pasteEvent([{ kind: 'file', type: 'image/png', file: makeImageFile() }], host);
    const prevent = vi.spyOn(evt, 'preventDefault');
    await act(async () => {
      window.dispatchEvent(evt);
      await Promise.resolve();
    });

    expect(stageImageMock).not.toHaveBeenCalled();
    expect(prevent).not.toHaveBeenCalled();
  });
});
