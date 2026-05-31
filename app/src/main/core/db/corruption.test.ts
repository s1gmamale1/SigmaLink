// DB-1 — tests for the SQLite corruption-recovery decision helpers.
//
// better-sqlite3 cannot load under vitest (built for Electron's ABI), so the
// Database wiring in client.ts is untested by design (documented gap). These
// pure helpers carry the corruption-detection + quarantine-naming logic that
// IS testable, and are the unit-level guard for the DB-1 boot-recovery path.

import { describe, expect, it } from 'vitest';
import { isCorruptionError, shouldQuarantine, corruptBackupPath } from './corruption';

describe('isCorruptionError', () => {
  it('returns true for SQLITE_CORRUPT', () => {
    expect(isCorruptionError({ code: 'SQLITE_CORRUPT' })).toBe(true);
  });

  it('returns true for SQLITE_NOTADB', () => {
    expect(isCorruptionError({ code: 'SQLITE_NOTADB' })).toBe(true);
  });

  it('returns true for a real Error carrying a corruption code', () => {
    const err = Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
    expect(isCorruptionError(err)).toBe(true);
  });

  it('returns false for an unrelated SQLite error (e.g. busy / locked)', () => {
    expect(isCorruptionError({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(isCorruptionError({ code: 'SQLITE_CANTOPEN' })).toBe(false);
  });

  it('returns false for errors without a code', () => {
    expect(isCorruptionError(new Error('boom'))).toBe(false);
  });

  it('returns false for null / undefined / non-objects', () => {
    expect(isCorruptionError(null)).toBe(false);
    expect(isCorruptionError(undefined)).toBe(false);
    expect(isCorruptionError('SQLITE_CORRUPT')).toBe(false);
    expect(isCorruptionError(42)).toBe(false);
  });
});

describe('shouldQuarantine (quick_check result)', () => {
  it('does NOT quarantine on a healthy scalar "ok"', () => {
    expect(shouldQuarantine('ok')).toBe(false);
  });

  it('does NOT quarantine on a healthy row-array [{ quick_check: "ok" }]', () => {
    expect(shouldQuarantine([{ quick_check: 'ok' }])).toBe(false);
  });

  it('is case/whitespace tolerant for a healthy result', () => {
    expect(shouldQuarantine('  OK  ')).toBe(false);
    expect(shouldQuarantine([{ quick_check: 'Ok' }])).toBe(false);
  });

  it('quarantines on a non-ok scalar', () => {
    expect(shouldQuarantine('*** in database main ***\nPage 3 is never used')).toBe(true);
  });

  it('quarantines on a row-array describing problems', () => {
    expect(
      shouldQuarantine([
        { quick_check: 'row 1 missing from index workspaces_root_idx' },
        { quick_check: 'wrong # of entries in index' },
      ]),
    ).toBe(true);
  });

  it('quarantines on an empty result (anomalous — no rows returned)', () => {
    expect(shouldQuarantine([])).toBe(true);
    expect(shouldQuarantine(undefined)).toBe(true);
    expect(shouldQuarantine(null)).toBe(true);
  });

  it('falls back to the first column value when the column is not named quick_check', () => {
    expect(shouldQuarantine([{ result: 'ok' }])).toBe(false);
    expect(shouldQuarantine([{ result: 'corrupt page 7' }])).toBe(true);
  });
});

describe('corruptBackupPath', () => {
  it('appends .corrupt-<timestamp> to the file path', () => {
    expect(corruptBackupPath('/data/sigmalink.db', 1_700_000_000_000)).toBe(
      '/data/sigmalink.db.corrupt-1700000000000',
    );
  });

  it('preserves the original file path verbatim (does not delete/overwrite)', () => {
    const original = '/Users/me/Library/Application Support/SigmaLink/sigmalink.db';
    const backup = corruptBackupPath(original, 12345);
    expect(backup.startsWith(original)).toBe(true);
    expect(backup).toBe(`${original}.corrupt-12345`);
  });

  it('produces distinct names for distinct timestamps', () => {
    expect(corruptBackupPath('/a/b.db', 1)).not.toBe(corruptBackupPath('/a/b.db', 2));
  });
});
