// 2026-07-03 (notification review medium #3) — kv-controller `onSet` hook.
//
// The daily-summary scheduler is armed once at boot; Settings persists the
// enable/time keys through this generic kv.set, so without a post-write hook
// an enable/re-time silently did nothing until app restart. The hook lets the
// router re-arm on the two daily keys at the ONE choke point every settings
// write already flows through.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.fn();
vi.mock('./client', () => ({
  getRawDb: vi.fn(() => ({
    prepare: () => ({
      run: (...args: unknown[]) => runMock(...args),
      get: () => undefined,
    }),
  })),
  getDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { buildKvController } from './kv-controller';

beforeEach(() => {
  runMock.mockReset();
});

describe('buildKvController — onSet hook', () => {
  it('calls onSet with the key AFTER a successful write', async () => {
    const onSet = vi.fn();
    const ctl = buildKvController({ onSet });
    await ctl.set('notifications.dailySummaryEnabled', '1');
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenCalledWith('notifications.dailySummaryEnabled');
  });

  it('a throwing onSet never breaks the write (set still resolves)', async () => {
    const ctl = buildKvController({
      onSet: () => {
        throw new Error('hook exploded');
      },
    });
    await expect(ctl.set('app.theme', 'dark')).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('omitting deps keeps the plain passthrough behaviour', async () => {
    const ctl = buildKvController();
    await expect(ctl.set('app.theme', 'dark')).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onSet when the key is invalid (write rejected)', async () => {
    const onSet = vi.fn();
    const ctl = buildKvController({ onSet });
    await expect(ctl.set('', 'x')).rejects.toThrow();
    expect(onSet).not.toHaveBeenCalled();
  });
});
