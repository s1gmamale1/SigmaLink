// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const applyZoom = vi.fn((f: number) => f);
const zoomByWheel = vi.fn((d: number) => (d < 0 ? 1.1 : 0.9));
const zoomIn = vi.fn(() => 1.1);
const zoomOut = vi.fn(() => 0.9);
const resetZoom = vi.fn(() => 1.0);
const persistZoom = vi.fn();
const notifyZoom = vi.fn();

vi.mock('@/renderer/lib/zoom', () => ({
  zoomByWheel: (d: number) => zoomByWheel(d),
  zoomIn: () => zoomIn(),
  zoomOut: () => zoomOut(),
  resetZoom: () => resetZoom(),
  persistZoom: (f: number) => persistZoom(f),
  notifyZoom: (f: number) => notifyZoom(f),
  applyZoom: (f: number) => applyZoom(f),
}));

import { useZoomControls } from './useZoomControls';

function Harness() {
  useZoomControls();
  return null;
}

function wheel(opts: { ctrlKey?: boolean; metaKey?: boolean; deltaY: number }): WheelEvent {
  const e = new Event('wheel', { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperty(e, 'ctrlKey', { value: opts.ctrlKey ?? false });
  Object.defineProperty(e, 'metaKey', { value: opts.metaKey ?? false });
  Object.defineProperty(e, 'deltaY', { value: opts.deltaY });
  return e;
}

beforeEach(() => {
  [applyZoom, zoomByWheel, zoomIn, zoomOut, resetZoom, persistZoom, notifyZoom].forEach((m) =>
    m.mockClear(),
  );
});
afterEach(() => {
  cleanup(); // per-file RTL cleanup (repo convention; vitest globals:false → no auto-cleanup)
  vi.restoreAllMocks();
});

describe('useZoomControls', () => {
  it('zooms + prevents default on a ctrl/meta wheel, and persists + notifies', () => {
    render(<Harness />);
    const e = wheel({ ctrlKey: true, deltaY: -120 });
    const prevented = vi.spyOn(e, 'preventDefault');
    window.dispatchEvent(e);
    expect(zoomByWheel).toHaveBeenCalledWith(-120);
    expect(prevented).toHaveBeenCalled();
    expect(persistZoom).toHaveBeenCalled();
    expect(notifyZoom).toHaveBeenCalled();
  });

  it('ignores a plain wheel (no modifier)', () => {
    render(<Harness />);
    const e = wheel({ deltaY: -120 });
    const prevented = vi.spyOn(e, 'preventDefault');
    window.dispatchEvent(e);
    expect(zoomByWheel).not.toHaveBeenCalled();
    expect(prevented).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+0 resets zoom', () => {
    render(<Harness />);
    const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
    const e = new KeyboardEvent('keydown', {
      key: '0',
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    expect(resetZoom).toHaveBeenCalled();
  });

  it('removes listeners on unmount', () => {
    const { unmount } = render(<Harness />);
    unmount();
    const e = wheel({ ctrlKey: true, deltaY: -120 });
    window.dispatchEvent(e);
    expect(zoomByWheel).not.toHaveBeenCalled();
  });
});
