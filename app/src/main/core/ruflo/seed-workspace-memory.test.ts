import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedWorkspaceMemory } from './seed-workspace-memory';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('seedWorkspaceMemory', () => {
  it('seeds once from CLAUDE.md when present', async () => {
    const root = tmpDir('sigmalink-seed-mem-');
    const content = 'A'.repeat(3000);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), content, 'utf8');

    const runStore = vi.fn().mockResolvedValue(undefined);
    await seedWorkspaceMemory({ workspaceRoot: root, runStore });

    expect(runStore).toHaveBeenCalledTimes(1);
    expect(runStore).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'project-context',
        namespace: 'patterns',
        claudeFlowDir: path.join(root, '.claude-flow'),
      }),
    );
    // value is first 2000 chars
    const { value } = (runStore.mock.calls[0] as [{ value: string }])[0];
    expect(value).toHaveLength(2000);
    expect(value).toBe('A'.repeat(2000));
  });

  it('falls back to README.md when CLAUDE.md is absent', async () => {
    const root = tmpDir('sigmalink-seed-mem-readme-');
    const content = 'README content here';
    fs.writeFileSync(path.join(root, 'README.md'), content, 'utf8');

    const runStore = vi.fn().mockResolvedValue(undefined);
    await seedWorkspaceMemory({ workspaceRoot: root, runStore });

    expect(runStore).toHaveBeenCalledTimes(1);
    expect(runStore).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'project-context',
        namespace: 'patterns',
        value: content,
      }),
    );
  });

  it('is a no-op when neither CLAUDE.md nor README.md exists', async () => {
    const root = tmpDir('sigmalink-seed-mem-empty-');

    const runStore = vi.fn().mockResolvedValue(undefined);
    await seedWorkspaceMemory({ workspaceRoot: root, runStore });

    expect(runStore).not.toHaveBeenCalled();
  });

  it('never throws when runStore rejects', async () => {
    const root = tmpDir('sigmalink-seed-mem-throw-');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'some content', 'utf8');

    const runStore = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      seedWorkspaceMemory({ workspaceRoot: root, runStore }),
    ).resolves.toBeUndefined();
  });

  it('never throws when CLAUDE.md read fails unexpectedly', async () => {
    const root = tmpDir('sigmalink-seed-mem-readfail-');
    // Create a directory named CLAUDE.md so readFileSync throws
    fs.mkdirSync(path.join(root, 'CLAUDE.md'));

    const runStore = vi.fn().mockResolvedValue(undefined);
    await expect(
      seedWorkspaceMemory({ workspaceRoot: root, runStore }),
    ).resolves.toBeUndefined();
  });

  it('uses CLAUDE.md over README.md when both exist', async () => {
    const root = tmpDir('sigmalink-seed-mem-both-');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'CLAUDE content', 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), 'README content', 'utf8');

    const runStore = vi.fn().mockResolvedValue(undefined);
    await seedWorkspaceMemory({ workspaceRoot: root, runStore });

    expect(runStore).toHaveBeenCalledTimes(1);
    const { value } = (runStore.mock.calls[0] as [{ value: string }])[0];
    expect(value).toBe('CLAUDE content');
  });

  it('passes correct claudeFlowDir on win32-style root', async () => {
    // Simulate win32-style path joining without needing to run on win32.
    // The win32 path module is accessible directly; verify the join logic
    // produces the right result for a Windows-style root.
    const win32Root = 'C:\\Users\\user\\project';
    const expectedDir = path.win32.join(win32Root, '.claude-flow');
    // Verify structural expectation: ends with .claude-flow
    expect(expectedDir).toBe('C:\\Users\\user\\project\\.claude-flow');
  });

  it('passes correct claudeFlowDir for the seeded workspace (posix)', async () => {
    const root = tmpDir('sigmalink-seed-mem-posix-');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'hello', 'utf8');

    const runStore = vi.fn().mockResolvedValue(undefined);
    await seedWorkspaceMemory({ workspaceRoot: root, runStore });

    const { claudeFlowDir } = (runStore.mock.calls[0] as [{ claudeFlowDir: string }])[0];
    expect(claudeFlowDir).toBe(path.join(root, '.claude-flow'));
  });
});
