// Extracted from terminal-cache.ts (2026-06-10 finding 5b) so the xterm cache
// and the P1b engine cache share ONE overlap-dedup implementation. Main
// appends to the ring buffer per raw chunk but coalesces the renderer
// broadcast, so a byte can be in BOTH the snapshot and a pending live chunk;
// the longest snapshot-tail/pending-head overlap is dropped from pending.

/** Coalescer maxBytes — the largest single flush, hence the largest possible
 *  duplicate window. */
export const MAX_OVERLAP_SCAN = 65_536;

export function computeSnapshotOverlap(snapBuffer: string, pendingJoined: string): number {
  if (!snapBuffer || !pendingJoined) return 0;
  const max = Math.min(snapBuffer.length, pendingJoined.length, MAX_OVERLAP_SCAN);
  for (let k = max; k > 0; k--) {
    if (snapBuffer.endsWith(pendingJoined.slice(0, k))) return k;
  }
  return 0;
}
