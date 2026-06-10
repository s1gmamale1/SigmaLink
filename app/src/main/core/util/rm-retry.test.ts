import { describe, it, expect, vi } from 'vitest';
import { rmDirWithRetry, WIN32_RM_RETRY_DELAYS_MS } from './rm-retry';

const errWith = (code: string) => Object.assign(new Error(code), { code });

describe('rmDirWithRetry', () => {
  it('win32: retries EBUSY/EPERM with backoff then succeeds', async () => {
    const rm = vi
      .fn()
      .mockRejectedValueOnce(errWith('EBUSY'))
      .mockRejectedValueOnce(errWith('EPERM'))
      .mockResolvedValueOnce(undefined);
    const sleeps: number[] = [];
    await rmDirWithRetry('/x/wt', {
      platform: 'win32',
      rm,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      warn: vi.fn(),
    });
    expect(rm).toHaveBeenCalledTimes(3);
    expect(rm).toHaveBeenCalledWith('/x/wt', { recursive: true, force: true });
    expect(sleeps).toEqual([WIN32_RM_RETRY_DELAYS_MS[0], WIN32_RM_RETRY_DELAYS_MS[1]]);
  });

  it('win32: exhausts retries → warns once and rethrows the last error', async () => {
    const rm = vi.fn().mockRejectedValue(errWith('EBUSY'));
    const warn = vi.fn();
    await expect(
      rmDirWithRetry('/x/wt', { platform: 'win32', rm, sleep: async () => {}, warn }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(rm).toHaveBeenCalledTimes(WIN32_RM_RETRY_DELAYS_MS.length + 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('win32: a non-retryable code throws immediately (no retry storm)', async () => {
    const rm = vi.fn().mockRejectedValue(errWith('EINVAL'));
    await expect(
      rmDirWithRetry('/x/wt', { platform: 'win32', rm, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('darwin: single attempt, no retry — behavior unchanged', async () => {
    const rm = vi.fn().mockRejectedValue(errWith('EBUSY'));
    const sleep = vi.fn();
    await expect(rmDirWithRetry('/x/wt', { platform: 'darwin', rm, sleep })).rejects.toMatchObject({
      code: 'EBUSY',
    });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('first-try success → no sleep, no warn', async () => {
    const rm = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn();
    const warn = vi.fn();
    await rmDirWithRetry('/x/wt', { platform: 'win32', rm, sleep, warn });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
