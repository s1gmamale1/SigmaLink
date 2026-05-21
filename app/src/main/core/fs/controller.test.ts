// W-8 — Unit tests for fsWriteFile path-containment guard.
// Verifies that files inside a worktree root are accepted and files outside
// are rejected, ensuring the save path-containment fix for per-pane worktrees.

import { describe, expect, it, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fsWriteFile } from './controller';

// Create a temp dir, write a file, clean up afterwards.
async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigmalink-fs-test-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('fsWriteFile — path-containment guard', () => {
  it('writes a file inside repoRoot (workspace root)', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'hello.txt');
      const result = await fsWriteFile({ path: target, content: 'hi', repoRoot: dir });
      expect(result.ok).toBe(true);
      const read = await fsp.readFile(target, 'utf8');
      expect(read).toBe('hi');
    });
  });

  it('writes a file inside a worktree root (different from workspace root)', async () => {
    // Simulate two separate dirs: workspace root and a worktree root.
    await withTmpDir(async (wsRoot) => {
      await withTmpDir(async (worktreeRoot) => {
        const target = path.join(worktreeRoot, 'agent-file.ts');
        // Pass worktreeRoot as repoRoot — the containment guard should accept it.
        const result = await fsWriteFile({
          path: target,
          content: 'export {};',
          repoRoot: worktreeRoot,
        });
        expect(result.ok).toBe(true);
        const read = await fsp.readFile(target, 'utf8');
        expect(read).toBe('export {};');

        // Passing wsRoot as repoRoot for the SAME file MUST be blocked
        // (target is in worktreeRoot, not wsRoot).
        await expect(
          fsWriteFile({ path: target, content: 'blocked', repoRoot: wsRoot }),
        ).rejects.toThrow('path traversal blocked');
      });
    });
  });

  it('blocks path traversal outside repoRoot', async () => {
    await withTmpDir(async (dir) => {
      // target is one level above the repoRoot — must be blocked.
      const target = path.join(dir, '..', 'escape.txt');
      await expect(
        fsWriteFile({ path: target, content: 'bad', repoRoot: dir }),
      ).rejects.toThrow('path traversal blocked');
    });
  });

  it('blocks absolute path outside repoRoot', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(os.tmpdir(), 'outside.txt');
      await expect(
        fsWriteFile({ path: target, content: 'bad', repoRoot: dir }),
      ).rejects.toThrow('path traversal blocked');
    });
  });

  it('rejects missing path or repoRoot', async () => {
    await expect(
      // @ts-expect-error — intentional bad input
      fsWriteFile({ path: '', content: 'x', repoRoot: '/tmp' }),
    ).rejects.toThrow('path and repoRoot required');

    await expect(
      // @ts-expect-error — intentional bad input
      fsWriteFile({ path: '/tmp/foo', content: 'x', repoRoot: '' }),
    ).rejects.toThrow('path and repoRoot required');
  });
});
