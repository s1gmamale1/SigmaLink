import { describe, expect, it } from 'vitest';
import { pickLinuxAppImage, pickMacDmg, resolveMacArch } from './update-asset';

/** The real asset list published in v3.0.0's latest-mac.yml, in manifest order.
 *  x64 deliberately precedes arm64 — that ordering is what made the old
 *  `files.find(f => f.url.endsWith('.dmg'))` hand x64 to every Mac. */
const V3_MAC_FILES = [
  { url: 'SigmaLink-3.0.0-mac.zip' },
  { url: 'SigmaLink-3.0.0-arm64-mac.zip' },
  { url: 'SigmaLink-3.0.0.dmg' },
  { url: 'SigmaLink-3.0.0-arm64.dmg' },
] as const;

describe('resolveMacArch', () => {
  it('reports arm64 for a native arm64 process', () => {
    expect(resolveMacArch({ processArch: 'arm64', runningUnderARM64Translation: false })).toBe('arm64');
  });

  it('reports arm64 for an x64 process translated by Rosetta', () => {
    expect(resolveMacArch({ processArch: 'x64', runningUnderARM64Translation: true })).toBe('arm64');
  });

  it('reports x64 for a genuine Intel process', () => {
    expect(resolveMacArch({ processArch: 'x64', runningUnderARM64Translation: false })).toBe('x64');
  });
});

describe('pickMacDmg', () => {
  it('picks the arm64 dmg on Apple Silicon even though x64 comes first', () => {
    expect(pickMacDmg(V3_MAC_FILES, 'arm64')?.url).toBe('SigmaLink-3.0.0-arm64.dmg');
  });

  it('picks the x64 dmg on Intel', () => {
    expect(pickMacDmg(V3_MAC_FILES, 'x64')?.url).toBe('SigmaLink-3.0.0.dmg');
  });

  it('falls back to x64 on Apple Silicon when no arm64 dmg is published', () => {
    const files = [{ url: 'SigmaLink-1.0.0.dmg' }];
    expect(pickMacDmg(files, 'arm64')?.url).toBe('SigmaLink-1.0.0.dmg');
  });

  it('never hands an arm64-only manifest to an Intel host', () => {
    const files = [{ url: 'SigmaLink-9.9.9-arm64.dmg' }];
    expect(pickMacDmg(files, 'x64')).toBeNull();
  });

  it('returns null when the manifest contains no dmg at all', () => {
    expect(pickMacDmg([{ url: 'SigmaLink-3.0.0-mac.zip' }], 'arm64')).toBeNull();
  });
});

describe('pickLinuxAppImage', () => {
  it('picks the x64 AppImage on x64', () => {
    const files = [{ url: 'SigmaLink-3.0.0.AppImage' }];
    expect(pickLinuxAppImage(files, 'x64')?.url).toBe('SigmaLink-3.0.0.AppImage');
  });

  it('prefers an arm64 AppImage on arm64 when one exists', () => {
    const files = [{ url: 'SigmaLink-3.0.0.AppImage' }, { url: 'SigmaLink-3.0.0-arm64.AppImage' }];
    expect(pickLinuxAppImage(files, 'arm64')?.url).toBe('SigmaLink-3.0.0-arm64.AppImage');
  });

  it('never hands an arm64-only AppImage to an x64 host', () => {
    expect(pickLinuxAppImage([{ url: 'SigmaLink-3.0.0-arm64.AppImage' }], 'x64')).toBeNull();
  });
});
