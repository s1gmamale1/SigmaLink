import { afterEach, describe, expect, it, vi } from 'vitest';

// Controllable mock of the PTY data bus.
vi.mock('@/renderer/lib/pty-data-bus', () => {
  const subs = new Map<string, (p: { sessionId: string; data: string }) => void>();
  return {
    subscribePtyData: (id: string, fn: (p: { sessionId: string; data: string }) => void) => {
      subs.set(id, fn);
      return () => subs.delete(id);
    },
    __emit: (id: string, data: string) => subs.get(id)?.({ sessionId: id, data }),
    __has: (id: string) => subs.has(id),
  };
});

import * as bus from '@/renderer/lib/pty-data-bus';
import { ensureLabelWatcher, disposeLabelWatcher, __resetLabelWatchers } from './label-watcher';
import { getAgentLabel, __resetAgentLabels } from './pane-labels';

const emit = (id: string, data: string) => (bus as unknown as { __emit: (i: string, d: string) => void }).__emit(id, data);
const has = (id: string) => (bus as unknown as { __has: (i: string) => boolean }).__has(id);

afterEach(() => { __resetLabelWatchers(); __resetAgentLabels(); });

describe('label-watcher', () => {
  it('parses a SIGMA::LABEL line into the label store', () => {
    ensureLabelWatcher('s1');
    emit('s1', 'SIGMA::LABEL Reviewing auth\n');
    expect(getAgentLabel('s1')).toBe('Reviewing auth');
  });
  it('handles a line split across two chunks', () => {
    ensureLabelWatcher('s1');
    emit('s1', 'SIGMA::LABEL Refactor');
    emit('s1', ' tokens\n');
    expect(getAgentLabel('s1')).toBe('Refactor tokens');
  });
  it('ignores non-LABEL output', () => {
    ensureLabelWatcher('s1');
    emit('s1', 'just normal terminal output\n');
    expect(getAgentLabel('s1')).toBeNull();
  });
  it('is idempotent (one subscription per session)', () => {
    ensureLabelWatcher('s1');
    ensureLabelWatcher('s1');
    expect(has('s1')).toBe(true);
  });
  it('disposeLabelWatcher unsubscribes', () => {
    ensureLabelWatcher('s1');
    disposeLabelWatcher('s1');
    expect(has('s1')).toBe(false);
  });
});
