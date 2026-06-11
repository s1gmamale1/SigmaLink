import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stageImage,
  sweepStagedImages,
  STAGED_IMAGES_DIR,
  STAGED_IMAGE_MAX_AGE_MS,
} from './stage-image';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-image-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('stageImage (spec 2026-06-10 B)', () => {
  it('writes the decoded bytes under <baseDir>/staged-images and returns the abs path', () => {
    const { absPath } = stageImage({ bytesBase64: PNG_B64, ext: 'png' }, { baseDir: dir });
    expect(absPath.startsWith(path.join(dir, 'staged-images'))).toBe(true);
    expect(absPath.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(absPath).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });
  it('rejects a non-allowlisted extension', () => {
    expect(() => stageImage({ bytesBase64: PNG_B64, ext: 'svg' }, { baseDir: dir })).toThrow(/unsupported extension/);
    expect(() => stageImage({ bytesBase64: PNG_B64, ext: '../../evil' }, { baseDir: dir })).toThrow(/unsupported extension/);
  });
  it('rejects an empty payload', () => {
    expect(() => stageImage({ bytesBase64: '', ext: 'png' }, { baseDir: dir })).toThrow(/empty payload/);
  });
  it('rejects an image over the 20MB cap', () => {
    const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    expect(() => stageImage({ bytesBase64: big, ext: 'png' }, { baseDir: dir })).toThrow(/20MB cap/);
  });
});

describe('sweepStagedImages (Phase 3 follow-up — staged-image janitor)', () => {
  // Injected fixed clock so the assertions never rely on real Date.now.
  const NOW = 1_000_000_000_000;

  it('returns all-zeros when the staged-images dir does not exist (fail-open)', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-empty-'));
    try {
      const res = await sweepStagedImages({ baseDir: fresh, now: NOW });
      expect(res).toEqual({ removed: 0, kept: 0, errors: 0 });
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('unlinks files older than the cutoff and keeps younger ones (injected fs + clock)', async () => {
    // Two old, one fresh. mtimes are injected via the fake stat.
    const mtimes: Record<string, number> = {
      'sigmalink-img-old-1.png': NOW - STAGED_IMAGE_MAX_AGE_MS - 1000,
      'sigmalink-img-old-2.png': NOW - STAGED_IMAGE_MAX_AGE_MS - 5_000,
      'sigmalink-img-fresh.png': NOW - 1000,
    };
    const unlinked: string[] = [];
    const res = await sweepStagedImages({
      baseDir: '/fake',
      now: NOW,
      deps: {
        readdir: async () => Object.keys(mtimes),
        stat: async (full) => ({ mtimeMs: mtimes[path.basename(full)] }),
        unlink: async (full) => {
          unlinked.push(path.basename(full));
        },
      },
    });

    expect(res).toEqual({ removed: 2, kept: 1, errors: 0 });
    expect(unlinked.sort()).toEqual(['sigmalink-img-old-1.png', 'sigmalink-img-old-2.png']);
  });

  it('reads from <baseDir>/staged-images', async () => {
    const seen: string[] = [];
    await sweepStagedImages({
      baseDir: '/userData',
      now: NOW,
      deps: {
        readdir: async (d) => {
          seen.push(d);
          return [];
        },
        stat: async () => ({ mtimeMs: 0 }),
        unlink: async () => undefined,
      },
    });
    expect(seen).toEqual([path.join('/userData', STAGED_IMAGES_DIR)]);
  });

  it('honours a custom maxAgeMs', async () => {
    const res = await sweepStagedImages({
      baseDir: '/fake',
      now: NOW,
      maxAgeMs: 1000, // 1s cutoff
      deps: {
        readdir: async () => ['a.png', 'b.png'],
        // a.png is 2s old (removed), b.png is 0.5s old (kept).
        stat: async (full) => ({ mtimeMs: path.basename(full) === 'a.png' ? NOW - 2000 : NOW - 500 }),
        unlink: async () => undefined,
      },
    });
    expect(res).toEqual({ removed: 1, kept: 1, errors: 0 });
  });

  it('counts a per-file stat/unlink failure as an error and continues (never throws)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await sweepStagedImages({
        baseDir: '/fake',
        now: NOW,
        deps: {
          readdir: async () => ['bad.png', 'good.png'],
          stat: async (full) => {
            if (path.basename(full) === 'bad.png') throw new Error('EACCES');
            return { mtimeMs: NOW - STAGED_IMAGE_MAX_AGE_MS - 1 };
          },
          unlink: async () => undefined,
        },
      });
      expect(res).toEqual({ removed: 1, kept: 0, errors: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  it('end-to-end with a REAL staged file: an old mtime is reaped, a fresh one survives', async () => {
    // No new Database() — pure fs. Stage one image, then back-date its mtime
    // past the cutoff and confirm the sweep (real Date.now path) removes it.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-real-'));
    try {
      const { absPath: oldFile } = stageImage({ bytesBase64: PNG_B64, ext: 'png' }, { baseDir: real });
      const { absPath: freshFile } = stageImage({ bytesBase64: PNG_B64, ext: 'png' }, { baseDir: real });
      // Back-date oldFile well past the 7-day window.
      const old = new Date(Date.now() - STAGED_IMAGE_MAX_AGE_MS - 60_000);
      fs.utimesSync(oldFile, old, old);

      const res = await sweepStagedImages({ baseDir: real });
      expect(res.removed).toBe(1);
      expect(res.kept).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(freshFile)).toBe(true);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
