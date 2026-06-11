// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ZoomIndicator } from './ZoomIndicator';
import { notifyZoom } from '@/renderer/lib/zoom';

// Use the REAL emitter from lib/zoom (subscribeZoom/notifyZoom are pure JS).
// Mock rpc so importing zoom.ts doesn't hit a real client.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: vi.fn() } },
  rpcSilent: { kv: { set: vi.fn() } },
}));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ZoomIndicator', () => {
  it('is hidden until a zoom event, then shows the percent', () => {
    const { container } = render(<ZoomIndicator />);
    expect(container.textContent).toBe('');
    act(() => {
      notifyZoom(1.2);
    });
    expect(container.textContent).toContain('120%');
  });

  it('hides again ~1s after the last zoom event', () => {
    const { container } = render(<ZoomIndicator />);
    act(() => {
      notifyZoom(1.5);
    });
    expect(container.textContent).toContain('150%');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(container.textContent).toBe('');
  });
});
