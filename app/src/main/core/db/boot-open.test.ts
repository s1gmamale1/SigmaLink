// win32-db-lifecycle (2026-06-11) — boot DB open: busy-retry + WAL reclaim.
//
// better-sqlite3 cannot load under vitest (Electron ABI) — `initialize` and
// the raw handle are injected fakes, per the MockDb/db-fake convention.

import { describe, it, expect, vi } from 'vitest';
import { isBusyError, openDatabaseWithBootRetry } from './boot-open';
import type Database from 'better-sqlite3';

function busyErr(code = 'SQLITE_BUSY', message = 'database is locked'): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function fakeOut(pragma = vi.fn()): { raw: Database.Database; pragma: ReturnType<typeof vi.fn> } {
  return { raw: { pragma } as unknown as Database.Database, pragma };
}

describe('isBusyError', () => {
  it('matches SQLITE_BUSY family codes', () => {
    expect(isBusyError(busyErr('SQLITE_BUSY'))).toBe(true);
    expect(isBusyError(busyErr('SQLITE_BUSY_RECOVERY'))).toBe(true);
    expect(isBusyError(busyErr('SQLITE_BUSY_SNAPSHOT'))).toBe(true);
  });

  it('matches the locked message without a code', () => {
    expect(isBusyError(new Error('database is locked'))).toBe(true);
    expect(isBusyError(new Error('database table is locked'))).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isBusyError(busyErr('SQLITE_CORRUPT', 'malformed'))).toBe(false);
    expect(isBusyError(new Error('EACCES'))).toBe(false);
    expect(isBusyError('database is locked')).toBe(false); // non-Error
    expect(isBusyError(null)).toBe(false);
  });
});

describe('openDatabaseWithBootRetry', () => {
  it('returns on first success and TRUNCATE-checkpoints the WAL', async () => {
    const out = fakeOut();
    const initialize = vi.fn(() => out);
    const sleep = vi.fn(async () => {});
    const result = await openDatabaseWithBootRetry('/ud', { initialize, sleep });
    expect(result).toBe(out);
    expect(initialize).toHaveBeenCalledExactlyOnceWith('/ud');
    expect(out.pragma).toHaveBeenCalledExactlyOnceWith('wal_checkpoint(TRUNCATE)');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries busy errors then succeeds (sleeps between attempts)', async () => {
    const out = fakeOut();
    const initialize = vi
      .fn()
      .mockImplementationOnce(() => {
        throw busyErr();
      })
      .mockImplementationOnce(() => {
        throw busyErr('SQLITE_BUSY_RECOVERY', 'recovery in progress');
      })
      .mockImplementation(() => out);
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const result = await openDatabaseWithBootRetry('/ud', { initialize, sleep, log });
    expect(result).toBe(out);
    expect(initialize).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-busy errors immediately — no retry', async () => {
    const corrupt = busyErr('SQLITE_CORRUPT', 'database disk image is malformed');
    const initialize = vi.fn(() => {
      throw corrupt;
    });
    const sleep = vi.fn(async () => {});
    await expect(
      openDatabaseWithBootRetry('/ud', { initialize, sleep }),
    ).rejects.toBe(corrupt);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the last busy error after exhausting attempts', async () => {
    const last = busyErr();
    const initialize = vi.fn(() => {
      throw last;
    });
    const sleep = vi.fn(async () => {});
    await expect(
      openDatabaseWithBootRetry('/ud', { initialize, sleep, attempts: 3 }),
    ).rejects.toBe(last);
    expect(initialize).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // no sleep after the final attempt
  });

  it('a checkpoint throw is non-fatal (logged, boot proceeds)', async () => {
    const pragma = vi.fn(() => {
      throw busyErr(); // orphan still pinning the WAL — reclaim later
    });
    const out = fakeOut(pragma);
    const initialize = vi.fn(() => out);
    const log = vi.fn();
    const result = await openDatabaseWithBootRetry('/ud', {
      initialize,
      sleep: async () => {},
      log,
    });
    expect(result).toBe(out);
    expect(log).toHaveBeenCalledOnce();
  });
});
