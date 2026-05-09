// Bounded scrollback buffer kept in main process so renderers can re-subscribe
// without losing history, even after a hot reload.

const DEFAULT_LIMIT = 256 * 1024; // 256 KiB per session

export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  private readonly limit: number;
  constructor(limit: number = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  append(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.size -= dropped.length;
    }
    // If a single chunk exceeds the limit, hard-trim it.
    if (this.size > this.limit && this.chunks.length === 1) {
      const only = this.chunks[0];
      const trimmed = only.slice(only.length - this.limit);
      this.chunks[0] = trimmed;
      this.size = trimmed.length;
    }
  }

  snapshot(): string {
    if (this.chunks.length === 0) return '';
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}
