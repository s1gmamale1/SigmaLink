// wav-encode.ts — PCM16 mono WAV encoder (C-10c).
//
// Encodes a Float32Array of audio samples (assumed 16-bit capable range [-1, 1])
// into a standard WAV buffer with the canonical 44-byte header.
//
// The output is a Node.js Buffer containing a complete, spec-compliant
// RIFF/WAVE file with a single `fmt ` chunk (PCM, mono, 16-bit) and a `data`
// chunk holding the little-endian signed-16 samples.

/**
 * Encode mono Float32 audio into a PCM-16 WAV Buffer.
 *
 * @param samples     Audio samples in [-1.0, 1.0] range.  Values outside this
 *                    range are clamped.
 * @param sampleRate  Sample rate in Hz (e.g. 16000, 44100, 48000).
 * @returns           A Buffer containing the complete WAV file bytes.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataLength = samples.length * blockAlign; // bytes for PCM data

  // Standard 44-byte WAV header + PCM data
  const buffer = Buffer.allocUnsafe(44 + dataLength);
  let offset = 0;

  // ── RIFF chunk descriptor ──────────────────────────────────────────────────
  buffer.write('RIFF', offset, 'ascii'); offset += 4;
  buffer.writeUInt32LE(36 + dataLength, offset); offset += 4; // ChunkSize
  buffer.write('WAVE', offset, 'ascii'); offset += 4;

  // ── fmt  sub-chunk ─────────────────────────────────────────────────────────
  buffer.write('fmt ', offset, 'ascii'); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;           // Subchunk1Size = 16 for PCM
  buffer.writeUInt16LE(1, offset); offset += 2;            // AudioFormat = 1 (PCM)
  buffer.writeUInt16LE(numChannels, offset); offset += 2;  // NumChannels = 1 (mono)
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;   // SampleRate
  buffer.writeUInt32LE(byteRate, offset); offset += 4;     // ByteRate
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;   // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2; // BitsPerSample = 16

  // ── data sub-chunk ─────────────────────────────────────────────────────────
  buffer.write('data', offset, 'ascii'); offset += 4;
  buffer.writeUInt32LE(dataLength, offset); offset += 4;

  // ── PCM samples (clamped, rounded, little-endian int16) ────────────────────
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Map [-1, 1] to [-32768, 32767]: multiply by 32767 for positive values,
    // by 32768 for negative values to reach the full int16 range.
    const int16 = clamped < 0
      ? Math.round(clamped * 32768)
      : Math.round(clamped * 32767);
    buffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  return buffer;
}
