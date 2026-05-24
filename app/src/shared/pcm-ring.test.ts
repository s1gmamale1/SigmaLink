// pcm-ring.test.ts — Unit tests for the rolling PCM ring buffer (C-11 / K1).
//
// Pure-fn tests run in the default node vitest environment with explicit
// imports (vitest.config has globals:false).

import { describe, it, expect } from 'vitest';
import { PcmRing } from './pcm-ring';

describe('PcmRing', () => {
  it('starts empty and lastN returns a zero-filled buffer', () => {
    const ring = new PcmRing(8);
    expect(ring.size).toBe(0);
    expect(ring.capacity).toBe(8);
    const out = ring.lastN(4);
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('push then lastN returns the most-recent samples in order', () => {
    const ring = new PcmRing(8);
    ring.push(new Float32Array([1, 2, 3, 4]));
    const out = ring.lastN(4);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('zero-pads on the LEFT when fewer samples than requested are available', () => {
    const ring = new PcmRing(8);
    ring.push(new Float32Array([5, 6]));
    const out = ring.lastN(4);
    // Most-recent samples sit at the END; the head is zero-padded.
    expect(Array.from(out)).toEqual([0, 0, 5, 6]);
  });

  it('clamps to capacity — only the most-recent `capacity` samples are kept', () => {
    const ring = new PcmRing(4);
    ring.push(new Float32Array([1, 2, 3, 4, 5, 6]));
    expect(ring.size).toBe(4);
    const out = ring.lastN(4);
    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it('wraps correctly across multiple pushes (circular write)', () => {
    const ring = new PcmRing(4);
    ring.push(new Float32Array([1, 2, 3]));
    ring.push(new Float32Array([4, 5]));
    // After 5 samples into a cap-4 ring, the oldest (1) is overwritten.
    expect(ring.size).toBe(4);
    expect(Array.from(ring.lastN(4))).toEqual([2, 3, 4, 5]);
  });

  it('lastN larger than capacity is clamped to capacity', () => {
    const ring = new PcmRing(4);
    ring.push(new Float32Array([1, 2, 3, 4]));
    const out = ring.lastN(100);
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('lastN(0) returns an empty buffer', () => {
    const ring = new PcmRing(4);
    ring.push(new Float32Array([1, 2, 3, 4]));
    expect(ring.lastN(0).length).toBe(0);
  });

  it('lastSeconds(sec, sampleRate) returns sec*rate most-recent samples', () => {
    const ring = new PcmRing(16000);
    ring.push(new Float32Array(16000).fill(0.5));
    const half = ring.lastSeconds(0.5, 16000);
    expect(half.length).toBe(8000);
    expect(half[0]).toBeCloseTo(0.5, 6);
  });

  it('lastSeconds clamps the requested window to the ring capacity', () => {
    const ring = new PcmRing(8000); // 0.5s @ 16kHz
    ring.push(new Float32Array(8000).fill(1));
    const out = ring.lastSeconds(3, 16000); // 48000 samples requested
    expect(out.length).toBe(8000);
  });

  it('reset() empties the ring', () => {
    const ring = new PcmRing(4);
    ring.push(new Float32Array([1, 2, 3, 4]));
    ring.reset();
    expect(ring.size).toBe(0);
    expect(Array.from(ring.lastN(2))).toEqual([0, 0]);
  });

  it('pushing an empty array is a no-op', () => {
    const ring = new PcmRing(4);
    ring.push(new Float32Array([1, 2]));
    ring.push(new Float32Array(0));
    expect(ring.size).toBe(2);
    expect(Array.from(ring.lastN(2))).toEqual([1, 2]);
  });

  it('a single push larger than capacity keeps only the tail', () => {
    const ring = new PcmRing(3);
    ring.push(new Float32Array([1, 2, 3, 4, 5]));
    expect(Array.from(ring.lastN(3))).toEqual([3, 4, 5]);
  });
});
