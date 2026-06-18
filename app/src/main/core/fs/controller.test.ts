// W-8 + Wave-1 H-2 — Unit tests for the fsWriteFile path-containment guard.
//
// Containment is now decided by the injected `allowedRoots` provider (the
// keystone in core/security/path-guard), NOT the renderer-supplied `repoRoot`.
// Each test supplies an `allowedRoots` provider; omitting it is fail-closed and
// covered explicitly below.

import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fsWriteFile, fsExists, fsCreateFile, fsMkdir, fsRename, fsTrash } from './controller';

// Create a temp dir, run the body, clean up afterwards.
async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigmalink-fs-test-'));
  try {
    // realpath so containment comparisons survive the macOS
    // /var/folders → /private/var/folders symlink.
    await fn(await fsp.realpath(dir));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const roots = (...dirs: string[]) => () => dirs;

describe('fsWriteFile — path-containment guard (allowed-roots)', () => {
  it('writes a file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'hello.txt');
      const result = await fsWriteFile({ path: target, content: 'hi', allowedRoots: roots(dir) });
      expect(result.ok).toBe(true);
      const read = await fsp.readFile(target, 'utf8');
      expect(read).toBe('hi');
    });
  });

  it('writes a file inside a worktree root (different from workspace root)', async () => {
    await withTmpDir(async (wsRoot) => {
      await withTmpDir(async (worktreeRoot) => {
        const target = path.join(worktreeRoot, 'agent-file.ts');
        // Both roots are allowed — the target inside worktreeRoot is accepted.
        const result = await fsWriteFile({
          path: target,
          content: 'export {};',
          allowedRoots: roots(wsRoot, worktreeRoot),
        });
        expect(result.ok).toBe(true);
        const read = await fsp.readFile(target, 'utf8');
        expect(read).toBe('export {};');

        // With ONLY wsRoot allowed, the same target (in worktreeRoot) is blocked.
        await expect(
          fsWriteFile({ path: target, content: 'blocked', allowedRoots: roots(wsRoot) }),
        ).rejects.toThrow('path outside workspace');
      });
    });
  });

  it('blocks path traversal outside the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, '..', 'escape.txt');
      await expect(
        fsWriteFile({ path: target, content: 'bad', allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });

  it('blocks an absolute path outside the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(os.tmpdir(), 'sigmalink-outside-marker.txt');
      await expect(
        fsWriteFile({ path: target, content: 'bad', allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });

  it('is fail-closed when no allowedRoots provider is supplied', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'hello.txt');
      // No allowedRoots ⇒ deny-all, even for a path that physically lives in a
      // perfectly ordinary temp dir.
      await expect(
        fsWriteFile({ path: target, content: 'x' }),
      ).rejects.toThrow('path outside workspace');
    });
  });

  it('rejects a missing path', async () => {
    await expect(
      fsWriteFile({ path: '', content: 'x', allowedRoots: roots('/tmp') }),
    ).rejects.toThrow('path required');
  });
});

// Audit 2026-06-10 finding 2 — fs.exists was the only fs.* channel skipping
// the allowedRoots sandbox (filesystem existence oracle). Out-of-roots must be
// indistinguishable from "absent": return false, never throw.
describe('fsExists — sandboxed existence probe', () => {
  it('returns true for an existing file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'present.txt');
      await fsp.writeFile(target, 'x', 'utf8');
      expect(fsExists({ path: target, allowedRoots: roots(dir) })).toBe(true);
    });
  });

  it('returns false for a missing file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      expect(fsExists({ path: path.join(dir, 'absent.txt'), allowedRoots: roots(dir) })).toBe(false);
    });
  });

  it('returns false for an EXISTING file outside every allowed root (oracle closed)', async () => {
    await withTmpDir(async (dir) => {
      await withTmpDir(async (outside) => {
        const target = path.join(outside, 'secret.txt');
        await fsp.writeFile(target, 'x', 'utf8');
        expect(fsExists({ path: target, allowedRoots: roots(dir) })).toBe(false);
      });
    });
  });

  it('fail-closed: returns false when no allowedRoots provider is wired', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'present.txt');
      await fsp.writeFile(target, 'x', 'utf8');
      expect(fsExists({ path: target })).toBe(false);
    });
  });
});

describe('fsCreateFile', () => {
  it('creates an empty file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'new.txt');
      const res = await fsCreateFile({ path: target, allowedRoots: roots(dir) });
      expect(res.ok).toBe(true);
      expect(await fsp.readFile(target, 'utf8')).toBe('');
    });
  });
  it('rejects clobbering an existing file', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'exists.txt');
      await fsp.writeFile(target, 'keep');
      await expect(
        fsCreateFile({ path: target, allowedRoots: roots(dir) }),
      ).rejects.toThrow(/fs\.createFile/);
      expect(await fsp.readFile(target, 'utf8')).toBe('keep'); // untouched
    });
  });
  it('rejects a path outside the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await expect(
        fsCreateFile({ path: path.join(dir, '..', 'escape.txt'), allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });
  it('is fail-closed with no allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await expect(fsCreateFile({ path: path.join(dir, 'x.txt') })).rejects.toThrow(
        'path outside workspace',
      );
    });
  });
});

describe('fsMkdir', () => {
  it('creates a directory inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'sub');
      const res = await fsMkdir({ path: target, allowedRoots: roots(dir) });
      expect(res.ok).toBe(true);
      expect((await fsp.stat(target)).isDirectory()).toBe(true);
    });
  });
  it('rejects when the directory already exists', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'sub');
      await fsp.mkdir(target);
      await expect(
        fsMkdir({ path: target, allowedRoots: roots(dir) }),
      ).rejects.toThrow(/fs\.mkdir/);
    });
  });
  it('rejects a path outside the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await expect(
        fsMkdir({ path: path.join(dir, '..', 'evil'), allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });
});

describe('fsRename', () => {
  it('renames a file within an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const from = path.join(dir, 'a.txt');
      const to = path.join(dir, 'b.txt');
      await fsp.writeFile(from, 'data');
      const res = await fsRename({ from, to, allowedRoots: roots(dir) });
      expect(res.ok).toBe(true);
      expect(await fsp.readFile(to, 'utf8')).toBe('data');
      expect(fsExists({ path: from, allowedRoots: roots(dir) })).toBe(false);
    });
  });
  it('rejects when the destination already exists', async () => {
    await withTmpDir(async (dir) => {
      const from = path.join(dir, 'a.txt');
      const to = path.join(dir, 'b.txt');
      await fsp.writeFile(from, 'a');
      await fsp.writeFile(to, 'b');
      await expect(
        fsRename({ from, to, allowedRoots: roots(dir) }),
      ).rejects.toThrow(/destination already exists/);
    });
  });
  it('rejects when the destination escapes the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      const from = path.join(dir, 'a.txt');
      await fsp.writeFile(from, 'a');
      await expect(
        fsRename({ from, to: path.join(dir, '..', 'b.txt'), allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });
  it('rejects when the source escapes the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await withTmpDir(async (other) => {
        const from = path.join(other, 'a.txt');
        await fsp.writeFile(from, 'a');
        await expect(
          fsRename({ from, to: path.join(dir, 'b.txt'), allowedRoots: roots(dir) }),
        ).rejects.toThrow('path outside workspace');
      });
    });
  });
});

describe('fsTrash', () => {
  it('contains the path then calls the injected trashItem with the realpath', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'doomed.txt');
      await fsp.writeFile(target, 'bye');
      const calls: string[] = [];
      const res = await fsTrash({
        path: target,
        allowedRoots: roots(dir),
        trashItem: async (p) => {
          calls.push(p);
        },
      });
      expect(res.ok).toBe(true);
      expect(calls).toEqual([target]); // contained, realpath'd target
    });
  });
  it('rejects out-of-roots BEFORE calling trashItem', async () => {
    await withTmpDir(async (dir) => {
      const calls: string[] = [];
      await expect(
        fsTrash({
          path: path.join(dir, '..', 'outside.txt'),
          allowedRoots: roots(dir),
          trashItem: async (p) => {
            calls.push(p);
          },
        }),
      ).rejects.toThrow('path outside workspace');
      expect(calls).toEqual([]);
    });
  });
});
