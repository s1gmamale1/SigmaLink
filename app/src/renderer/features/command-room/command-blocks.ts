// P2 — OSC-133 marks → command blocks (the wishlist segmentation item).
// A block spans from one prompt mark (A) to the row before the next A; the
// last block is open-ended. Exit code comes from the D mark inside the span.

import type { PromptMark } from '@/renderer/lib/terminal-engine';

export interface CommandBlock {
  startRow: number;
  /** inclusive; Infinity for the open (latest) block */
  endRow: number;
  exitCode: number | undefined;
}

export function deriveBlocks(marks: readonly PromptMark[]): CommandBlock[] {
  const prompts = marks.filter((m) => m.kind === 'A');
  return prompts.map((a, i) => {
    const next = prompts[i + 1];
    const endRow = next ? next.row - 1 : Number.POSITIVE_INFINITY;
    const d = marks.find((m) => m.kind === 'D' && m.row >= a.row && m.row <= endRow);
    return { startRow: a.row, endRow, exitCode: d?.exitCode };
  });
}
