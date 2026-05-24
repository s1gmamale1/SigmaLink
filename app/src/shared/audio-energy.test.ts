// audio-energy.test.ts — RMS energy gate tests (C-11 / K2).
//
// The listening loop calls `isSpeech(ring.lastSeconds(0.5, rate), thold)` each
// tick; only when it returns true do we spend a Whisper pass. This keeps idle
// CPU low (silence never reaches the model).

import { describe, it, expect } from 'vitest';
import { rms, isSpeech, DEFAULT_SPEECH_THRESHOLD } from './audio-energy';

describe('rms', () => {
  it('is 0 for an all-silent buffer', () => {
    expect(rms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it('is 0 for an empty buffer (no divide-by-zero)', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('equals the amplitude for a constant signal', () => {
    // rms of a constant c is |c|.
    expect(rms(new Float32Array([0.5, 0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 6);
  });

  it('computes the known RMS of a ±1 square wave', () => {
    // sqrt(mean(1,1,1,1)) = 1
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 6);
  });

  it('computes a known mixed value', () => {
    // mean of squares = (0.09 + 0.16 + 0.25)/3 = 0.16667 → sqrt ≈ 0.40825
    expect(rms(new Float32Array([0.3, -0.4, 0.5]))).toBeCloseTo(0.40825, 4);
  });
});

describe('isSpeech', () => {
  it('returns false for silence', () => {
    expect(isSpeech(new Float32Array(256).fill(0), 0.01)).toBe(false);
  });

  it('returns true when energy is above the threshold', () => {
    expect(isSpeech(new Float32Array(256).fill(0.2), 0.05)).toBe(true);
  });

  it('returns false when energy is below the threshold', () => {
    expect(isSpeech(new Float32Array(256).fill(0.01), 0.05)).toBe(false);
  });

  it('uses a strict comparison at the boundary (== threshold is not speech)', () => {
    // 0.5 is exactly representable in float32, so rms of a constant-0.5 signal
    // is exactly 0.5 — a clean boundary with no float32/float64 rounding skew.
    expect(isSpeech(new Float32Array(64).fill(0.5), 0.5)).toBe(false); // == → not speech
    expect(isSpeech(new Float32Array(64).fill(0.5), 0.4)).toBe(true);  // above → speech
    expect(isSpeech(new Float32Array(64).fill(0.5), 0.6)).toBe(false); // below → not speech
  });

  it('falls back to DEFAULT_SPEECH_THRESHOLD when no threshold is given', () => {
    expect(typeof DEFAULT_SPEECH_THRESHOLD).toBe('number');
    expect(DEFAULT_SPEECH_THRESHOLD).toBeGreaterThan(0);
    // Loud signal clears the default; near-silence does not.
    expect(isSpeech(new Float32Array(256).fill(0.2))).toBe(true);
    expect(isSpeech(new Float32Array(256).fill(0.0005))).toBe(false);
  });

  it('treats an empty buffer as non-speech', () => {
    expect(isSpeech(new Float32Array(0), 0.01)).toBe(false);
  });
});
