// v1.9-scrollback — Unit tests for RingBuffer.restore()

import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer';

describe('RingBuffer.restore()', () => {
  it('seeds the buffer with prior content', () => {
    const buf = new RingBuffer(1024);
    buf.restore('hello restored');
    expect(buf.snapshot()).toBe('hello restored');
  });

  it('is a no-op for empty string', () => {
    const buf = new RingBuffer(1024);
    buf.restore('');
    expect(buf.snapshot()).toBe('');
  });

  it('respects the cap: over-cap content is tail-truncated', () => {
    const limit = 10;
    const buf = new RingBuffer(limit);
    const overCap = 'abcdefghij12345'; // 15 chars > limit 10
    buf.restore(overCap);
    const snap = buf.snapshot();
    // Must not exceed the limit
    expect(snap.length).toBeLessThanOrEqual(limit);
    // Must be the tail
    expect(snap).toBe(overCap.slice(overCap.length - limit));
  });

  it('exactly-at-cap content is kept as-is', () => {
    const limit = 10;
    const buf = new RingBuffer(limit);
    const exact = '0123456789';
    buf.restore(exact);
    expect(buf.snapshot()).toBe(exact);
  });

  it('subsequent append() extends the restored content naturally', () => {
    const buf = new RingBuffer(1024);
    buf.restore('prior ');
    buf.append('live');
    expect(buf.snapshot()).toBe('prior live');
  });

  it('restore() after append() replaces existing content', () => {
    const buf = new RingBuffer(1024);
    buf.append('stale');
    buf.restore('fresh');
    expect(buf.snapshot()).toBe('fresh');
  });

  it('clear() after restore() empties the buffer', () => {
    const buf = new RingBuffer(1024);
    buf.restore('data');
    buf.clear();
    expect(buf.snapshot()).toBe('');
  });

  it('restore() on over-cap then append keeps total under cap', () => {
    const limit = 10;
    const buf = new RingBuffer(limit);
    buf.restore('abcdefghij'); // exactly at cap
    buf.append('XYZ'); // push 3 more chars
    // append() trims: total would be 13; oldest chars dropped
    const snap = buf.snapshot();
    expect(snap.length).toBeLessThanOrEqual(limit);
    expect(snap.endsWith('XYZ')).toBe(true);
  });
});
