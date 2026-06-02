// P4.2 — DigestCollector unit tests. A mock memoryManager (appendToMemory) +
// stubbed timer harness drive the batch/flush, severity-filter, dedup, and
// null-workspace paths. No DB, no real timers.

import { describe, expect, it, vi } from 'vitest';
import {
  DigestCollector,
  dailyNoteName,
  parseMinSeverity,
} from './agent-digest';
import type { Notification, NotificationSeverity } from '../../../shared/types';

function makeNotification(over: Partial<Notification> = {}): Notification {
  return {
    id: over.id ?? `id-${Math.random()}`,
    // Respect an explicit `null` (app-global) — `?? 'ws-1'` would eat it.
    workspaceId: 'workspaceId' in over ? (over.workspaceId ?? null) : 'ws-1',
    kind: over.kind ?? 'pty-exit',
    severity: over.severity ?? 'warn',
    title: over.title ?? 'Agent exited (code 1)',
    body: over.body ?? null,
    payload: null,
    sourceEvent: null,
    dedupKey: over.dedupKey ?? 'dk',
    dupCount: 1,
    createdAt: over.createdAt ?? Date.now(),
    readAt: null,
  };
}

/** Timer harness: capture armed callbacks, fire on demand. */
function makeTimerHarness() {
  const armed: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = (cb: () => void, ms: number) => {
    const e = { cb, ms, cancelled: false };
    armed.push(e);
    return { unref: () => undefined, __idx: armed.length - 1 };
  };
  const clearTimer = (handle: unknown) => {
    const idx = (handle as { __idx?: number }).__idx;
    if (typeof idx === 'number' && armed[idx]) armed[idx].cancelled = true;
  };
  const fireLast = () => {
    const last = armed[armed.length - 1];
    if (last && !last.cancelled) last.cb();
  };
  return { armed, setTimer, clearTimer, fireLast };
}

const FIXED = new Date(2026, 5, 2, 14, 30, 0, 0); // 2026-06-02 14:30 local

function makeCollector(opts: {
  append: ReturnType<typeof vi.fn>;
  enabled?: boolean;
  minSeverity?: NotificationSeverity;
  now?: Date;
  harness: ReturnType<typeof makeTimerHarness>;
}) {
  return new DigestCollector({
    appendToMemory: opts.append as never,
    isEnabled: () => opts.enabled ?? true,
    getMinSeverity: () => opts.minSeverity ?? 'warn',
    now: () => opts.now ?? FIXED,
    setTimer: opts.harness.setTimer,
    clearTimer: opts.harness.clearTimer,
  });
}

describe('dailyNoteName', () => {
  it('formats local YYYY-MM-DD zero-padded', () => {
    expect(dailyNoteName(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('parseMinSeverity', () => {
  it('accepts valid severities and defaults the rest to warn', () => {
    expect(parseMinSeverity('error')).toBe('error');
    expect(parseMinSeverity('info')).toBe('info');
    expect(parseMinSeverity(null)).toBe('warn');
    expect(parseMinSeverity('garbage')).toBe('warn');
  });
});

describe('DigestCollector', () => {
  it('batches multiple events into ONE append after the flush fires', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: 'a', title: 'first' }));
    c.onNotification(makeNotification({ id: 'b', title: 'second' }));
    // Nothing written yet — buffered behind the debounce.
    expect(append).not.toHaveBeenCalled();
    // Only one timer armed (coalesced).
    expect(h.armed).toHaveLength(1);
    h.fireLast();
    await Promise.resolve();
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(1);
    const arg = append.mock.calls[0][0] as { workspaceId: string; name: string; text: string };
    expect(arg.workspaceId).toBe('ws-1');
    expect(arg.name).toBe('2026-06-02');
    expect(arg.text).toBe('- 14:30 — pty-exit: first\n- 14:30 — pty-exit: second\n');
  });

  it('filters out events below the min-severity floor', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, minSeverity: 'error', harness: h });
    c.onNotification(makeNotification({ id: 'w', severity: 'warn' })); // dropped
    c.onNotification(makeNotification({ id: 'e', severity: 'error', title: 'boom' }));
    expect(h.armed).toHaveLength(1); // only the error armed a flush
    h.fireLast();
    await Promise.resolve();
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(1);
    expect((append.mock.calls[0][0] as { text: string }).text).toBe(
      '- 14:30 — pty-exit: boom\n',
    );
  });

  it('dedups by notification id within the day (a bumped row is not re-logged)', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: 'dup', title: 'once' }));
    c.onNotification(makeNotification({ id: 'dup', title: 'once (×2)' })); // same id
    h.fireLast();
    await Promise.resolve();
    await Promise.resolve();
    expect((append.mock.calls[0][0] as { text: string }).text).toBe(
      '- 14:30 — pty-exit: once\n',
    );
  });

  it('skips null-workspace (app-global) notifications', () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: 'g', workspaceId: null }));
    expect(h.armed).toHaveLength(0); // nothing buffered, nothing armed
  });

  it('does not journal its own daily-summary kind', () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: 's', kind: 'daily-summary', severity: 'info' }));
    expect(h.armed).toHaveLength(0);
  });

  it('is inert while disabled', () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, enabled: false, harness: h });
    c.onNotification(makeNotification({ id: 'x' }));
    expect(h.armed).toHaveLength(0);
  });

  it('groups distinct workspaces into separate appends', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: '1', workspaceId: 'ws-1', title: 'A' }));
    c.onNotification(makeNotification({ id: '2', workspaceId: 'ws-2', title: 'B' }));
    h.fireLast();
    await Promise.resolve();
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(2);
    const ids = append.mock.calls.map((c2) => (c2[0] as { workspaceId: string }).workspaceId);
    expect(new Set(ids)).toEqual(new Set(['ws-1', 'ws-2']));
  });

  it('flushNow drains the buffer immediately', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: 'q', title: 'flush me' }));
    await c.flushNow();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('a failed append does not throw out of the flush', async () => {
    const append = vi.fn().mockRejectedValue(new Error('ws closed'));
    const h = makeTimerHarness();
    const c = makeCollector({ append, harness: h });
    c.onNotification(makeNotification({ id: 'z' }));
    await expect(c.flushNow()).resolves.toBeUndefined();
  });
});
