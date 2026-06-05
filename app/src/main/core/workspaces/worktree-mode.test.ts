import { describe, it, expect } from 'vitest';
import { readWorktreeMode } from './worktree-mode';

function rawStub(value: string | undefined) {
  return {
    prepare: () => ({
      get: () => (value === undefined ? undefined : { value }),
    }),
  } as unknown as ReturnType<typeof import('../db/client').getRawDb>;
}

describe('readWorktreeMode', () => {
  it('returns in-place only for the exact string', () => {
    expect(readWorktreeMode(rawStub('in-place'), 'ws1')).toBe('in-place');
  });
  it('defaults to worktree when unset', () => {
    expect(readWorktreeMode(rawStub(undefined), 'ws1')).toBe('worktree');
  });
  it('defaults to worktree for any other value (fail-safe)', () => {
    expect(readWorktreeMode(rawStub('garbage'), 'ws1')).toBe('worktree');
  });
  it('defaults to worktree for the empty string', () => {
    expect(readWorktreeMode(rawStub(''), 'ws1')).toBe('worktree');
  });
  it('uses workspaceId in the KV key', () => {
    let capturedKey: string | undefined;
    const stubCapture = {
      prepare: (_sql: string) => ({
        get: (key: string) => {
          capturedKey = key;
          return undefined;
        },
      }),
    } as unknown as ReturnType<typeof import('../db/client').getRawDb>;
    readWorktreeMode(stubCapture, 'ws-abc');
    expect(capturedKey).toBe('workspace.worktreeMode.ws-abc');
  });
});
