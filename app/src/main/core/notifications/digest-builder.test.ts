// P4.2 NTF-DIGEST — buildDailySummary unit tests. The row source is injected
// (`queryDay`) as an in-memory array — no DB, no `new Database()`. We assert the
// grouping, the daily-summary kind + dedupKey, the empty-day no-op, and that the
// query window is the local-day [midnight, now).

import { describe, expect, it, vi } from 'vitest';
import {
  buildDailySummary,
  type DigestRow,
  type DigestNotificationsSink,
} from './digest-builder';

function makeSink() {
  const add = vi.fn();
  const sink: DigestNotificationsSink = { add };
  return { sink, add };
}

const NOW = new Date(2026, 5, 2, 18, 0, 0, 0); // 2026-06-02 18:00 local

describe('buildDailySummary', () => {
  it('groups rows by kind + severity and posts a daily-summary notification', () => {
    const { sink, add } = makeSink();
    const rows: DigestRow[] = [
      { kind: 'pty-exit', severity: 'warn' },
      { kind: 'pty-exit', severity: 'error' },
      { kind: 'swarm-message', severity: 'info' },
      { kind: 'tool-error', severity: 'error' },
    ];
    const posted = buildDailySummary({ notifications: sink, queryDay: () => rows }, NOW);
    expect(posted).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    const arg = add.mock.calls[0][0] as {
      workspaceId: string | null;
      kind: string;
      severity: string;
      title: string;
      body: string | null;
      dedupKey: string;
    };
    expect(arg.kind).toBe('daily-summary');
    expect(arg.severity).toBe('info');
    expect(arg.workspaceId).toBeNull();
    expect(arg.dedupKey).toBe('daily-summary:2026-06-02');
    expect(arg.title).toBe('Daily summary — 4 events');
    // Body: severity rollup line (highest-first) then per-kind counts.
    expect(arg.body).toContain('2 error');
    expect(arg.body).toContain('1 warn');
    expect(arg.body).toContain('1 info');
    expect(arg.body).toContain('pty-exit: 2');
    expect(arg.body).toContain('tool-error: 1');
    expect(arg.body).toContain('swarm-message: 1');
  });

  it('uses singular "event" for a single row', () => {
    const { sink, add } = makeSink();
    buildDailySummary(
      { notifications: sink, queryDay: () => [{ kind: 'pty-exit', severity: 'warn' }] },
      NOW,
    );
    expect((add.mock.calls[0][0] as { title: string }).title).toBe('Daily summary — 1 event');
  });

  it('no-ops (no add) on an empty day', () => {
    const { sink, add } = makeSink();
    const posted = buildDailySummary({ notifications: sink, queryDay: () => [] }, NOW);
    expect(posted).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('queries the local-day window [midnight, now)', () => {
    const { sink } = makeSink();
    let captured: { since: number; until: number } | null = null;
    const queryDay = (since: number, until: number): DigestRow[] => {
      captured = { since, until };
      return [{ kind: 'x', severity: 'warn' }];
    };
    buildDailySummary({ notifications: sink, queryDay }, NOW);
    const midnight = new Date(2026, 5, 2, 0, 0, 0, 0).getTime();
    expect(captured).toEqual({ since: midnight, until: NOW.getTime() });
  });

  it('sorts kind lines by count desc then name for stability', () => {
    const { sink, add } = makeSink();
    const rows: DigestRow[] = [
      { kind: 'bbb', severity: 'warn' },
      { kind: 'aaa', severity: 'warn' },
      { kind: 'aaa', severity: 'warn' },
    ];
    buildDailySummary({ notifications: sink, queryDay: () => rows }, NOW);
    const body = (add.mock.calls[0][0] as { body: string }).body;
    const lines = body.split('\n');
    // First line is the severity rollup; kind lines follow.
    expect(lines.indexOf('aaa: 2')).toBeLessThan(lines.indexOf('bbb: 1'));
  });
});
