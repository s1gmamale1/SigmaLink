// wav-encode.test.ts — Unit tests for the PCM16 WAV encoder (C-10c).
//
// Run via:
//   npx vitest run packages/voice-core/src/wav-encode.test.ts

import { describe, it, expect } from 'vitest';
import { encodeWav } from './wav-encode.js';

// Helper: read a 4-byte ASCII tag from the buffer at `offset`.
function tag(buf: Buffer, offset: number): string {
  return buf.subarray(offset, offset + 4).toString('ascii');
}

describe('encodeWav — RIFF/WAVE header structure', () => {
  it('first 4 bytes are RIFF', () => {
    const buf = encodeWav(new Float32Array(16), 16000);
    expect(tag(buf, 0)).toBe('RIFF');
  });

  it('bytes 8-12 are WAVE', () => {
    const buf = encodeWav(new Float32Array(16), 16000);
    expect(tag(buf, 8)).toBe('WAVE');
  });

  it('bytes 12-16 are fmt  (fmt + space)', () => {
    const buf = encodeWav(new Float32Array(16), 16000);
    expect(tag(buf, 12)).toBe('fmt ');
  });

  it('total buffer length is 44 (header) + samples.length * 2 (PCM)', () => {
    const samples = new Float32Array(100);
    const buf = encodeWav(samples, 16000);
    expect(buf.length).toBe(44 + 100 * 2);
  });

  it('data chunk length field equals samples.length * 2', () => {
    const samples = new Float32Array(50);
    const buf = encodeWav(samples, 16000);
    // data sub-chunk starts at byte 36: 4-byte 'data' tag + 4-byte length
    const dataLength = buf.readUInt32LE(40);
    expect(dataLength).toBe(50 * 2);
  });
});

describe('encodeWav — fmt  sub-chunk fields', () => {
  it('AudioFormat is 1 (PCM)', () => {
    const buf = encodeWav(new Float32Array(8), 44100);
    expect(buf.readUInt16LE(20)).toBe(1);
  });

  it('NumChannels is 1 (mono)', () => {
    const buf = encodeWav(new Float32Array(8), 44100);
    expect(buf.readUInt16LE(22)).toBe(1);
  });

  it('SampleRate matches the argument passed in', () => {
    const buf16k = encodeWav(new Float32Array(8), 16000);
    expect(buf16k.readUInt32LE(24)).toBe(16000);

    const buf48k = encodeWav(new Float32Array(8), 48000);
    expect(buf48k.readUInt32LE(24)).toBe(48000);
  });

  it('BitsPerSample is 16', () => {
    const buf = encodeWav(new Float32Array(8), 16000);
    expect(buf.readUInt16LE(34)).toBe(16);
  });

  it('ByteRate equals sampleRate * 1 channel * 2 bytes', () => {
    const buf = encodeWav(new Float32Array(8), 44100);
    expect(buf.readUInt32LE(28)).toBe(44100 * 1 * 2);
  });

  it('BlockAlign is 2 (mono 16-bit = 2 bytes per sample)', () => {
    const buf = encodeWav(new Float32Array(8), 16000);
    expect(buf.readUInt16LE(32)).toBe(2);
  });
});

describe('encodeWav — sample encoding', () => {
  it('0.0 encodes as int16 0', () => {
    const buf = encodeWav(new Float32Array([0]), 16000);
    expect(buf.readInt16LE(44)).toBe(0);
  });

  it('1.0 encodes as int16 32767', () => {
    const buf = encodeWav(new Float32Array([1]), 16000);
    expect(buf.readInt16LE(44)).toBe(32767);
  });

  it('-1.0 encodes as int16 -32768', () => {
    const buf = encodeWav(new Float32Array([-1]), 16000);
    expect(buf.readInt16LE(44)).toBe(-32768);
  });

  it('samples [0, 1, -1] → int16 [0, 32767, -32768]', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1]), 16000);
    expect(buf.readInt16LE(44)).toBe(0);
    expect(buf.readInt16LE(46)).toBe(32767);
    expect(buf.readInt16LE(48)).toBe(-32768);
  });

  it('values > 1.0 are clamped to 32767', () => {
    const buf = encodeWav(new Float32Array([2.0]), 16000);
    expect(buf.readInt16LE(44)).toBe(32767);
  });

  it('values < -1.0 are clamped to -32768', () => {
    const buf = encodeWav(new Float32Array([-2.0]), 16000);
    expect(buf.readInt16LE(44)).toBe(-32768);
  });

  it('0.5 encodes as a positive int16 (≈ 16383)', () => {
    const buf = encodeWav(new Float32Array([0.5]), 16000);
    const val = buf.readInt16LE(44);
    expect(val).toBeGreaterThan(16000);
    expect(val).toBeLessThanOrEqual(32767);
  });

  it('samples are written in little-endian order', () => {
    const buf = encodeWav(new Float32Array([1.0]), 16000);
    // int16 32767 = 0x7FFF; little-endian: bytes [0xFF, 0x7F]
    expect(buf[44]).toBe(0xFF);
    expect(buf[45]).toBe(0x7F);
  });
});

describe('encodeWav — edge cases', () => {
  it('empty samples produces a valid 44-byte WAV header with zero data', () => {
    const buf = encodeWav(new Float32Array(0), 16000);
    expect(buf.length).toBe(44);
    expect(tag(buf, 0)).toBe('RIFF');
    expect(buf.readUInt32LE(40)).toBe(0); // data length
  });

  it('RIFF chunk size = 36 + dataLength', () => {
    const samples = new Float32Array(100);
    const buf = encodeWav(samples, 16000);
    const chunkSize = buf.readUInt32LE(4);
    expect(chunkSize).toBe(36 + 100 * 2);
  });
});
