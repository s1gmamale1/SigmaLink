import { describe, expect, it } from 'vitest';
import { isZoomWheel, ctrlWheelShouldBubble } from './wheel-zoom';

describe('isZoomWheel', () => {
  it('is true when ctrl or meta is held', () => {
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true);
  });
  it('is false for a plain wheel', () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('ctrlWheelShouldBubble', () => {
  it('returns false for a zoom wheel (suppress local scroll, let it bubble)', () => {
    expect(ctrlWheelShouldBubble({ ctrlKey: true, metaKey: false })).toBe(false);
  });
  it('returns true for a plain wheel (local scroll proceeds)', () => {
    expect(ctrlWheelShouldBubble({ ctrlKey: false, metaKey: false })).toBe(true);
  });
});
