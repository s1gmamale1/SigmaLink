// pcm-ring.ts — Fixed-size circular Float32 PCM buffer (C-11 / K1).
//
// Used by the "Hey Jorvis" always-on listening loop to hold a rolling window
// of the most-recent audio (≈3 s) so a wake-word transcribe pass can run on
// the tail without re-allocating per push. The native `onPcm` tap streams
// continuous Float32 chunks; each is `push`ed into the ring and the loop reads
// `lastSeconds(3, sampleRate)` / `lastSeconds(0.5, sampleRate)` to gate energy.
//
// Semantics:
//   - `push(chunk)` appends samples, overwriting the oldest once full.
//   - `lastN(count)` returns the most-recent `count` samples as a NEW
//     Float32Array. The most-recent sample is the LAST element. When fewer
//     than `count` samples are available the head is zero-padded; `count` is
//     clamped to `capacity`.
//   - Pure, allocation-light, no external deps — testable in node env.

export class PcmRing {
  private readonly buffer: Float32Array;
  private readonly _capacity: number;
  /** Index where the next sample will be written. */
  private writeIndex = 0;
  /** Number of valid samples currently stored (≤ capacity). */
  private count = 0;

  constructor(capacity: number) {
    // Guard against degenerate capacities; a 1-sample ring is the floor.
    this._capacity = Math.max(1, Math.floor(capacity));
    this.buffer = new Float32Array(this._capacity);
  }

  /** Total number of samples this ring can hold. */
  get capacity(): number {
    return this._capacity;
  }

  /** Number of valid samples currently stored. */
  get size(): number {
    return this.count;
  }

  /**
   * Append `chunk` to the ring, overwriting the oldest samples once full.
   * When `chunk` is longer than the capacity only its tail is retained.
   */
  push(chunk: Float32Array): void {
    const n = chunk.length;
    if (n === 0) return;

    // If the incoming chunk alone exceeds capacity, only its tail matters.
    if (n >= this._capacity) {
      this.buffer.set(chunk.subarray(n - this._capacity));
      this.writeIndex = 0;
      this.count = this._capacity;
      return;
    }

    // Write up to the end of the backing buffer, then wrap the remainder.
    const firstSpan = Math.min(n, this._capacity - this.writeIndex);
    this.buffer.set(chunk.subarray(0, firstSpan), this.writeIndex);
    const remaining = n - firstSpan;
    if (remaining > 0) {
      this.buffer.set(chunk.subarray(firstSpan), 0);
    }
    this.writeIndex = (this.writeIndex + n) % this._capacity;
    this.count = Math.min(this.count + n, this._capacity);
  }

  /**
   * Return the most-recent `count` samples (most-recent last). When fewer than
   * `count` samples are stored the result is zero-padded at the head. `count`
   * is clamped to the ring capacity and to ≥ 0.
   */
  lastN(count: number): Float32Array {
    const want = Math.max(0, Math.min(Math.floor(count), this._capacity));
    const out = new Float32Array(want);
    if (want === 0) return out;

    const available = Math.min(want, this.count);
    if (available === 0) return out; // all-zero

    // The oldest valid sample sits `count` positions behind writeIndex.
    // Read the most-recent `available` samples ending just before writeIndex.
    const start = (this.writeIndex - available + this._capacity * 2) % this._capacity;
    // Destination offset zero-pads the head when available < want.
    const destOffset = want - available;
    for (let i = 0; i < available; i += 1) {
      out[destOffset + i] = this.buffer[(start + i) % this._capacity];
    }
    return out;
  }

  /**
   * Convenience: return the most-recent `sec` seconds at `sampleRate`. The
   * window is clamped to the ring capacity.
   */
  lastSeconds(sec: number, sampleRate: number): Float32Array {
    return this.lastN(Math.floor(sec * sampleRate));
  }

  /** Empty the ring. */
  reset(): void {
    this.writeIndex = 0;
    this.count = 0;
    this.buffer.fill(0);
  }
}
