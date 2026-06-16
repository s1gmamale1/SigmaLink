import { describe, expect, it } from 'vitest';
import { linuxToolPathCandidates, mergePathEntries } from './linux-path';

describe('linuxToolPathCandidates', () => {
  it('returns Ubuntu-friendly user tool directories before system dirs', () => {
    expect(linuxToolPathCandidates('/home/sigma')).toEqual([
      '/home/sigma/.local/bin',
      '/home/sigma/.npm-global/bin',
      '/home/sigma/.npm/bin',
      '/home/sigma/.bun/bin',
      '/home/sigma/.cargo/bin',
      '/home/sigma/.asdf/shims',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });
});

describe('mergePathEntries', () => {
  it('prepends existing candidates and keeps existing PATH entries without duplicates', () => {
    const merged = mergePathEntries(['/a', '/b', '/missing'], '/b:/c', {
      delimiter: ':',
      exists: (p) => p !== '/missing',
    });

    expect(merged).toBe('/a:/b:/c');
  });
});
