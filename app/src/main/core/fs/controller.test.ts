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
import { fsWriteFile } from './controller';

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
