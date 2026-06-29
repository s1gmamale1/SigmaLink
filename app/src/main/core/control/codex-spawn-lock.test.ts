import { afterEach, describe, expect, it } from 'vitest';
import { withCodexSpawnLock, _resetLocksForTest } from './codex-spawn-lock';

afterEach(() => {
  _resetLocksForTest();
});

describe('withCodexSpawnLock', () => {
  // ── serialization (same home) ───────────────────────────────────────────────

  it('same home: second fn starts only after first releases', async () => {
    const log: string[] = [];
    let releaseFirst!: () => void;

    const firstDone = withCodexSpawnLock('/home/a/.codex', () => {
      log.push('1:start');
      return new Promise<void>((resolve) => {
        releaseFirst = () => { log.push('1:done'); resolve(); };
      });
    }, { maxHoldMs: 60_000 });

    const secondDone = withCodexSpawnLock('/home/a/.codex', async () => {
      log.push('2:start');
    }, { maxHoldMs: 60_000 });

    // Drain microtasks: first acquires the lock and calls its fn.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toEqual(['1:start']); // second has NOT started yet

    releaseFirst();
    await Promise.all([firstDone, secondDone]);

    expect(log).toEqual(['1:start', '1:done', '2:start']);
  });

  it('same home: three sequential callers run in order', async () => {
    const log: string[] = [];
    let rel1!: () => void;
    let rel2!: () => void;

    const p1 = withCodexSpawnLock('/h', () => {
      log.push('1');
      return new Promise<void>((r) => { rel1 = r; });
    }, { maxHoldMs: 60_000 });
    const p2 = withCodexSpawnLock('/h', () => {
      log.push('2');
      return new Promise<void>((r) => { rel2 = r; });
    }, { maxHoldMs: 60_000 });
    const p3 = withCodexSpawnLock('/h', async () => { log.push('3'); }, { maxHoldMs: 60_000 });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toEqual(['1']);
    rel1();
    await p1;

    await Promise.resolve();
    await Promise.resolve();

    expect(log).toEqual(['1', '2']);
    rel2();
    await Promise.all([p2, p3]);

    expect(log).toEqual(['1', '2', '3']);
  });

  // ── concurrency (different homes) ──────────────────────────────────────────

  it('different homes: both fns start concurrently without blocking each other', async () => {
    const log: string[] = [];
    let relA!: () => void;
    let relB!: () => void;

    const lockA = withCodexSpawnLock('/home/a/.codex', () => {
      log.push('A:start');
      return new Promise<void>((r) => { relA = r; });
    }, { maxHoldMs: 60_000 });

    const lockB = withCodexSpawnLock('/home/b/.codex', () => {
      log.push('B:start');
      return new Promise<void>((r) => { relB = r; });
    }, { maxHoldMs: 60_000 });

    // Drain microtasks
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toContain('A:start');
    expect(log).toContain('B:start');

    relA();
    relB();
    await Promise.all([lockA, lockB]);
  });

  // ── maxHoldMs cap (fake timer) ──────────────────────────────────────────────

  it('maxHoldMs: releases a hung holder so the next waiter starts', async () => {
    const log: string[] = [];

    // Fake timer — we fire it manually to simulate time advancing.
    const timers: Array<{ fn: () => void; id: number }> = [];
    let nextId = 0;
    const fakeSet = (fn: () => void, _ms: number): number => {
      const id = ++nextId;
      timers.push({ fn, id });
      return id;
    };
    const fakeClear = (id: unknown): void => {
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    };

    const timerOpts = { maxHoldMs: 100, setTimer: fakeSet, clearTimer: fakeClear };

    // First: a fn that hangs forever (simulates codex stuck on auth).
    // We deliberately do NOT await this — it never resolves.
    void withCodexSpawnLock('/home/.codex', () => {
      log.push('first:start');
      return new Promise<void>(() => { /* never */ });
    }, timerOpts);

    const secondDone = withCodexSpawnLock('/home/.codex', async () => {
      log.push('second:start');
    }, timerOpts);

    // Let the first acquire the lock and start.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toEqual(['first:start']);
    expect(timers.length).toBeGreaterThanOrEqual(1);

    // Fire the cap timer — releases the lock even though first is still running.
    timers[0]!.fn();

    await secondDone;
    expect(log).toContain('second:start');
  });

  // ── return value pass-through ───────────────────────────────────────────────

  it('returns the value resolved by fn', async () => {
    const result = await withCodexSpawnLock('/home/x', async () => 42, { maxHoldMs: 100 });
    expect(result).toBe(42);
  });

  it('propagates rejections from fn', async () => {
    await expect(
      withCodexSpawnLock('/home/x', async () => {
        throw new Error('auth-fail');
      }, { maxHoldMs: 100 }),
    ).rejects.toThrow('auth-fail');
  });

  // ── lock is released even on rejection ─────────────────────────────────────

  it('lock releases after rejection so the next caller is not blocked', async () => {
    const log: string[] = [];

    const first = withCodexSpawnLock('/home/y', async () => {
      log.push('1');
      throw new Error('boom');
    }, { maxHoldMs: 60_000 }).catch(() => { /* absorb */ });

    const second = withCodexSpawnLock('/home/y', async () => {
      log.push('2');
    }, { maxHoldMs: 60_000 });

    await Promise.all([first, second]);
    expect(log).toEqual(['1', '2']);
  });
});
