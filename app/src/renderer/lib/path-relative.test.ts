// v1.5.1-A — Unit tests for pathRelative().

import { describe, expect, it } from 'vitest';
import { pathRelative } from './path-relative';

describe('pathRelative — POSIX paths', () => {
  it('returns relative path when abs is under root', () => {
    expect(pathRelative('/home/user/project/src/App.tsx', '/home/user/project')).toBe(
      'src/App.tsx',
    );
  });

  it('handles root with trailing slash', () => {
    expect(pathRelative('/home/user/project/src/App.tsx', '/home/user/project/')).toBe(
      'src/App.tsx',
    );
  });

  it('returns abs unchanged when abs is NOT under root', () => {
    expect(pathRelative('/other/path/file.ts', '/home/user/project')).toBe('/other/path/file.ts');
  });

  it('returns abs unchanged when abs equals root (no trailing slash)', () => {
    expect(pathRelative('/home/user/project', '/home/user/project')).toBe('/home/user/project');
  });

  it('handles nested paths correctly', () => {
    expect(pathRelative('/workspace/a/b/c/d.ts', '/workspace/a')).toBe('b/c/d.ts');
  });
});

describe('pathRelative — Windows paths', () => {
  it('returns relative path for Windows separator', () => {
    expect(pathRelative('C:\\Users\\user\\project\\src\\App.tsx', 'C:\\Users\\user\\project')).toBe(
      'src\\App.tsx',
    );
  });

  it('handles Windows root with trailing backslash', () => {
    expect(
      pathRelative('C:\\Users\\user\\project\\src\\App.tsx', 'C:\\Users\\user\\project\\'),
    ).toBe('src\\App.tsx');
  });

  it('returns abs unchanged when abs is NOT under Windows root', () => {
    expect(pathRelative('C:\\Other\\file.ts', 'C:\\Users\\user\\project')).toBe('C:\\Other\\file.ts');
  });
});

describe('pathRelative — edge cases', () => {
  it('prevents partial directory name collisions (root=/foo/bar, abs=/foo/barbaz/f.ts)', () => {
    // /foo/bar + sep = /foo/bar/ — should NOT match /foo/barbaz/
    expect(pathRelative('/foo/barbaz/f.ts', '/foo/bar')).toBe('/foo/barbaz/f.ts');
  });
});
