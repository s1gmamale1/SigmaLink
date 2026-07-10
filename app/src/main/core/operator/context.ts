// P2 Task 6 — wake-time memory context assembly. Pure, DI-free string
// transform (no DB, no I/O — the caller already recalled the memories via
// `./memory`'s `recallMemories`): turns a ranked list of `JorvisMemory` rows
// into the '## Operator memory' block spliced into a wake directive
// (directive.ts's new `extraContext` param), hard-capped at
// MAX_MEMORY_CONTEXT_CHARS so a burst of long memories can't blow the
// model's context on one wake — mirrors directive.ts's MAX_EXCERPT_CHARS
// pattern (a char-cap constant, not KV; D4).
//
// The cap drops WHOLE entries, never cuts one mid-line: entries are appended
// in the caller's given order (e.g. recallMemories' bm25 rank — best match
// first) until the next entry would push the block over budget, then the
// remaining (lowest-ranked) entries are omitted entirely. If nothing survives
// (including the empty-input case), the result is '' — a bare heading with no
// bullet lines under it would be a confusing artifact in the directive, and
// directive.ts's "append only when non-empty" check relies on '' meaning
// "nothing to show".

import type { JorvisMemory } from '../../../shared/types';

export const MAX_MEMORY_CONTEXT_CHARS = 3000;

const HEADING = '## Operator memory';

function formatEntry(memory: JorvisMemory): string {
  return `- [${memory.kind}] ${memory.title}: ${memory.body}`;
}

export function buildMemoryContext(memories: JorvisMemory[]): string {
  if (memories.length === 0) return '';

  const lines: string[] = [HEADING];
  let length = HEADING.length;

  for (const memory of memories) {
    const line = formatEntry(memory);
    const addedLength = 1 + line.length; // +1 for the '\n' joining it on
    if (length + addedLength > MAX_MEMORY_CONTEXT_CHARS) break;
    lines.push(line);
    length += addedLength;
  }

  return lines.length > 1 ? lines.join('\n') : '';
}
