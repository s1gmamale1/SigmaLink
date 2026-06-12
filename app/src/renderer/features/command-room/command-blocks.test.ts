import { describe, expect, it } from 'vitest';
import { deriveBlocks } from './command-blocks';
import type { PromptMark } from '@/renderer/lib/terminal-engine';

describe('deriveBlocks', () => {
  it('one block per prompt mark, exit code from the D mark inside it', () => {
    const marks: PromptMark[] = [
      { kind: 'A', row: 0 },
      { kind: 'C', row: 1 },
      { kind: 'D', row: 4, exitCode: 2 },
      { kind: 'A', row: 5 },
    ];
    expect(deriveBlocks(marks)).toEqual([
      { startRow: 0, endRow: 4, exitCode: 2 },
      { startRow: 5, endRow: Number.POSITIVE_INFINITY, exitCode: undefined },
    ]);
  });
  it('no marks → no blocks', () => {
    expect(deriveBlocks([])).toEqual([]);
  });
});
