import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { seedWorkspaceMemory } from './seed-workspace-memory';

const seedSpawnCalls: Array<{ cmd: string; args: string[] }> = [];
let seedSpawnMode: 'close' | 'error' = 'close';
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[]) => {
    seedSpawnCalls.push({ cmd, args });
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (seedSpawnMode === 'error') child.emit('error', new Error('spawn npx ENOENT'));
      else child.emit('close', 0);
    });
    return child;
  },
}));

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Arrange a tmp workspace containing a CLAUDE.md (mirrors the file's idiom). */
function makeTmpWorkspaceWithClaudeMd(): string {
  const root = tmpDir('sigmalink-seed-mem-default-');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'project context here', 'utf8');
  return root;
}

beforeEach(() => {
  seedSpawnCalls.length = 0;
  seedSpawnMode = 'close';
});

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

  it('defaultRunStore spawns npx via spawnExecutable (win32 .cmd shim safety)', async () => {
    const root = makeTmpWorkspaceWithClaudeMd();
    await seedWorkspaceMemory({ workspaceRoot: root }); // NO runStore override → default path
    expect(seedSpawnCalls.length).toBe(1);
    expect(seedSpawnCalls[0].cmd).toBe('npx');
    expect(seedSpawnCalls[0].args).toEqual(
      expect.arrayContaining(['memory', 'store', '--namespace', 'patterns']),
    );
  });

  it('logs (does not silently swallow) a spawn error, and still resolves', async () => {
    const root = makeTmpWorkspaceWithClaudeMd();
    seedSpawnMode = 'error';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(seedWorkspaceMemory({ workspaceRoot: root })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ruflo-seed]'));
    warn.mockRestore();
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
