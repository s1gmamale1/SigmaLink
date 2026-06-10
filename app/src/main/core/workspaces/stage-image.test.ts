import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageImage } from './stage-image';

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
