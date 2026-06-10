// v1.9-scrollback — Unit tests for scrollback-store.ts
// All file I/O is mocked so tests run without a real filesystem.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Mock node:fs before importing the module under test.
vi.mock('node:fs', () => {
  return {
    default: {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: vi.fn(),
      readdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

import fs from 'node:fs';
import { persistScrollback, loadScrollback, gcScrollback, SCROLLBACK_MAX_BYTES } from './scrollback-store';

// Typed spy helpers
const mkdirSync = fs.mkdirSync as unknown as MockInstance;
const writeFileSync = fs.writeFileSync as unknown as MockInstance;
const renameSync = fs.renameSync as unknown as MockInstance;
const readFileSync = fs.readFileSync as unknown as MockInstance;
const readdirSync = fs.readdirSync as unknown as MockInstance;
const unlinkSync = fs.unlinkSync as unknown as MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  // Silence console.warn so test output is clean
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── persistScrollback ───────────────────────────────────────────────────────

describe('persistScrollback()', () => {
  it('creates the scrollback directory and writes via tmp→rename', () => {
    persistScrollback('/userData', 'sess-1', 'hello');
    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('scrollback'), { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/sess-1\.log\.tmp$/),
      'hello',
      'utf8',
    );
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/sess-1\.log\.tmp$/),
      expect.stringMatching(/sess-1\.log$/),
    );
  });

  it('tail-truncates content over SCROLLBACK_MAX_BYTES', () => {
    const bigText = 'x'.repeat(SCROLLBACK_MAX_BYTES + 100);
    persistScrollback('/userData', 'sess-big', bigText);
    const written = (writeFileSync as unknown as MockInstance).mock.calls[0]?.[1] as string;
    expect(written.length).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES);
    // Must be the tail
    expect(written).toBe(bigText.slice(-SCROLLBACK_MAX_BYTES));
  });

  it('does not truncate content at exactly SCROLLBACK_MAX_BYTES', () => {
    const exact = 'y'.repeat(SCROLLBACK_MAX_BYTES);
    persistScrollback('/userData', 'sess-exact', exact);
    const written = (writeFileSync as unknown as MockInstance).mock.calls[0]?.[1] as string;
    expect(written).toBe(exact);
  });

  it('tolerates I/O errors (ENOENT, EPERM) without throwing', () => {
    mkdirSync.mockImplementation(() => { throw new Error('EPERM'); });
    expect(() => persistScrollback('/userData', 'sess-err', 'data')).not.toThrow();
  });
});

// ─── loadScrollback ──────────────────────────────────────────────────────────

describe('loadScrollback()', () => {
  it('returns file content on success', () => {
    readFileSync.mockReturnValue('restored content');
    const result = loadScrollback('/userData', 'sess-1');
    expect(result).toBe('restored content');
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/sess-1\.log$/),
      'utf8',
    );
  });

  it("returns '' when the file is absent (ENOENT)", () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    readFileSync.mockImplementation(() => { throw err; });
    const result = loadScrollback('/userData', 'sess-missing');
    expect(result).toBe('');
  });

  it("returns '' on other I/O errors without throwing", () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    readFileSync.mockImplementation(() => { throw err; });
    expect(() => {
      const r = loadScrollback('/userData', 'sess-perm');
      expect(r).toBe('');
    }).not.toThrow();
  });

  it('persist→load round-trip returns the original content', () => {
    const content = 'round-trip data';
    // Capture what was written by persistScrollback
    let capturedContent = '';
    writeFileSync.mockImplementation((_path: string, data: string) => {
      capturedContent = data;
    });
    renameSync.mockImplementation(() => undefined);
    mkdirSync.mockImplementation(() => undefined);
    readFileSync.mockImplementation(() => capturedContent);

    persistScrollback('/userData', 'sess-rt', content);
    const loaded = loadScrollback('/userData', 'sess-rt');
    expect(loaded).toBe(content);
  });
});

// ─── gcScrollback ────────────────────────────────────────────────────────────

describe('gcScrollback()', () => {
  it('removes .log files for sessions not in liveSessionIds', () => {
    readdirSync.mockReturnValue(['dead-sess.log', 'live-sess.log', 'another-dead.log', 'notlog.txt']);
    const liveIds = new Set(['live-sess']);
    gcScrollback('/userData', liveIds);
    // dead-sess and another-dead deleted; live-sess kept; notlog.txt skipped
    expect(unlinkSync).toHaveBeenCalledTimes(2);
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/dead-sess\.log$/));
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/another-dead\.log$/));
    expect(unlinkSync).not.toHaveBeenCalledWith(expect.stringMatching(/live-sess\.log$/));
  });

  it('keeps .log files for sessions that ARE in liveSessionIds', () => {
    readdirSync.mockReturnValue(['sess-a.log', 'sess-b.log']);
    const liveIds = new Set(['sess-a', 'sess-b']);
    gcScrollback('/userData', liveIds);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('is a no-op when the scrollback dir does not exist (ENOENT)', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    readdirSync.mockImplementation(() => { throw err; });
    expect(() => gcScrollback('/userData', new Set())).not.toThrow();
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('tolerates errors on individual file unlinks without throwing', () => {
    readdirSync.mockReturnValue(['dead.log']);
    unlinkSync.mockImplementation(() => { throw new Error('EPERM'); });
    expect(() => gcScrollback('/userData', new Set())).not.toThrow();
  });

  it('removes crash-orphaned .log.tmp files for dead sessions (2026-06-10 audit, finding 4)', () => {
    readdirSync.mockReturnValue(['dead.log.tmp', 'live.log.tmp', 'dead2.log', 'notlog.txt']);
    const liveIds = new Set(['live']);
    gcScrollback('/userData', liveIds);
    expect(unlinkSync).toHaveBeenCalledTimes(2);
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/dead\.log\.tmp$/));
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/dead2\.log$/));
    expect(unlinkSync).not.toHaveBeenCalledWith(expect.stringMatching(/live\.log\.tmp$/));
  });
});
