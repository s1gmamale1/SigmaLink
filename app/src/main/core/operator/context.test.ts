// P2 Task 6 — wake-time memory context assembly tests. Pure string-transform
// assertions: buildMemoryContext turns a list of recalled JorvisMemory rows
// into the '## Operator memory' block spliced into a wake directive
// (directive.ts). No DB, no DI, no I/O — mirrors directive.test.ts's style.

import { describe, it, expect } from 'vitest';
import { buildMemoryContext, MAX_MEMORY_CONTEXT_CHARS } from './context';
import type { JorvisMemory } from '../../../shared/types';

function makeMemory(overrides: Partial<JorvisMemory> = {}): JorvisMemory {
  return {
    id: 'mem-1',
    kind: 'fact',
    title: 'Deploy key rotates monthly',
    body: 'Rotate the deploy key on the 1st; ping ops if the rotation job fails.',
    tags: [],
    workspaceId: null,
    confidence: 0.8,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

describe('MAX_MEMORY_CONTEXT_CHARS', () => {
  it('is pinned at 3000 (the plan-locked budget)', () => {
    expect(MAX_MEMORY_CONTEXT_CHARS).toBe(3000);
  });
});

describe('buildMemoryContext', () => {
  it('returns an empty string for an empty memory list', () => {
    expect(buildMemoryContext([])).toBe('');
  });

  it('renders the heading and one formatted entry line for a single memory', () => {
    const context = buildMemoryContext([makeMemory()]);
    expect(context).toContain('## Operator memory');
    expect(context).toContain(
      '- [fact] Deploy key rotates monthly: Rotate the deploy key on the 1st; ping ops if the rotation job fails.',
    );
  });

  it('formats each entry as "- [kind] title: body"', () => {
    const memory = makeMemory({ kind: 'playbook', title: 'T', body: 'B' });
    const context = buildMemoryContext([memory]);
    expect(context).toContain('- [playbook] T: B');
  });

  it('renders multiple entries in the given order (caller\'s rank order, e.g. bm25)', () => {
    const a = makeMemory({ id: 'a', title: 'First', body: 'first body' });
    const b = makeMemory({ id: 'b', title: 'Second', body: 'second body' });
    const context = buildMemoryContext([a, b]);
    expect(context.indexOf('First')).toBeLessThan(context.indexOf('Second'));
    expect(context).toContain('- [fact] First: first body');
    expect(context).toContain('- [fact] Second: second body');
  });

  it('never exceeds MAX_MEMORY_CONTEXT_CHARS, even with oversized memories', () => {
    const a = makeMemory({ id: 'a', title: 'A', body: 'a'.repeat(2000) });
    const b = makeMemory({ id: 'b', title: 'B', body: 'b'.repeat(2000) });
    const context = buildMemoryContext([a, b]);
    expect(context.length).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT_CHARS);
  });

  it('truncates at entry boundaries — an overflowing entry is wholly absent, never partially present', () => {
    const a = makeMemory({ id: 'a', title: 'A', body: 'a'.repeat(2000) });
    const b = makeMemory({ id: 'b', title: 'B', body: 'b'.repeat(2000) });
    const context = buildMemoryContext([a, b]);
    // A fits whole and intact — every 'a' character present, unbroken.
    expect(context).toContain(`- [fact] A: ${'a'.repeat(2000)}`);
    // B does not fit — must be wholly absent, not truncated mid-line.
    expect(context).not.toContain('b');
    expect(context).not.toContain('[fact] B');
  });

  it('drops a single memory entirely (returns "") when even the first entry alone exceeds the cap', () => {
    const huge = makeMemory({ title: 'Huge', body: 'x'.repeat(MAX_MEMORY_CONTEXT_CHARS * 2) });
    const context = buildMemoryContext([huge]);
    expect(context).toBe('');
  });

  it('keeps every surviving entry fully intact — no truncated bullet lines — across many entries', () => {
    const memories: JorvisMemory[] = Array.from({ length: 40 }, (_, i) =>
      makeMemory({ id: `m${i}`, title: `Memory ${i}`, body: 'x'.repeat(100) }),
    );
    const context = buildMemoryContext(memories);
    expect(context.length).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT_CHARS);
    const lines = context.split('\n').slice(1); // drop the heading line
    expect(lines.length).toBeGreaterThan(0); // some entries must have survived
    for (const line of lines) {
      expect(line).toMatch(/^- \[fact\] Memory \d+: x{100}$/);
    }
  });
});
