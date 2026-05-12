// Vitest coverage for `resolveAndSpawn`'s ENOENT fallback walk.
//
// The original launcher.spec.ts under `__tests__` uses `node:test` and is not
// picked up by the vitest runner. This file is intentionally narrower: it
// asserts the specific fallback contract that Fix 1 restores — when the
// registry rejects the primary command with ENOENT, the loop must continue
// to the next alt-command rather than terminating.

import { describe, it, expect } from 'vitest';

import { resolveAndSpawn, ProviderLaunchError, type LauncherDeps } from './launcher';
import type { AgentProviderDefinition } from '../../../shared/providers';
import type { SessionRecord } from '../pty/registry';

function makeFakeSession(id = 'sess'): SessionRecord {
  return {
    id,
    providerId: 'test',
    cwd: '/tmp',
    pid: 1234,
    alive: true,
    startedAt: Date.now(),
    pty: {
      pid: 1234,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
    buffer: {
      snapshot: () => '',
      append: () => undefined,
      clear: () => undefined,
    } as unknown as SessionRecord['buffer'],
    unsubData: () => undefined,
    unsubExit: () => undefined,
  };
}

interface MockSpawn {
  command: string;
  args: string[];
}

function mockRegistry(
  behaviour: (call: MockSpawn) => SessionRecord | Error,
): {
  registry: LauncherDeps['ptyRegistry'];
  calls: MockSpawn[];
} {
  const calls: MockSpawn[] = [];
  const registry = {
    create(input: {
      providerId: string;
      command: string;
      args: string[];
      cwd: string;
      cols: number;
      rows: number;
    }) {
      const captured = { command: input.command, args: input.args };
      calls.push(captured);
      const result = behaviour(captured);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as LauncherDeps['ptyRegistry'];
  return { registry, calls };
}

const claudeProvider: AgentProviderDefinition = {
  id: 'claude',
  name: 'Claude',
  description: '',
  command: 'claude',
  altCommands: ['claude.cmd', 'claude.exe'],
  args: [],
  autoApproveFlag: '--dangerously-skip-permissions',
  color: '#000',
  icon: '',
  installHint: 'npm i -g @anthropic-ai/claude-code',
};

describe('resolveAndSpawn ENOENT fallback walk', () => {
  it('continues to altCommands when the primary command ENOENTs', () => {
    let attempt = 0;
    const { registry, calls } = mockRegistry(() => {
      attempt += 1;
      if (attempt === 1) {
        return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      }
      return makeFakeSession('s-cmd');
    });
    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
      },
      { providerId: 'claude', cwd: '/tmp' },
    );
    expect(result.commandUsed).toBe('claude.cmd');
    expect(calls.map((c) => c.command)).toEqual(['claude', 'claude.cmd']);
  });

  it('walks every alt before giving up', () => {
    const { registry, calls } = mockRegistry(() =>
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    );
    expect(() =>
      resolveAndSpawn(
        {
          ptyRegistry: registry,
          getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
        },
        { providerId: 'claude', cwd: '/tmp' },
      ),
    ).toThrow(ProviderLaunchError);
    expect(calls.map((c) => c.command)).toEqual([
      'claude',
      'claude.cmd',
      'claude.exe',
    ]);
  });

  it('treats an Error whose message contains ENOENT as ENOENT', () => {
    // Some node-pty error paths don't set `.code` but the message reads
    // `spawn claude ENOENT`. The launcher's isENOENT() heuristic covers that.
    let attempt = 0;
    const { registry, calls } = mockRegistry(() => {
      attempt += 1;
      if (attempt === 1) return new Error('spawn claude ENOENT');
      return makeFakeSession('s-cmd');
    });
    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
      },
      { providerId: 'claude', cwd: '/tmp' },
    );
    expect(result.commandUsed).toBe('claude.cmd');
    expect(calls).toHaveLength(2);
  });

  it('does NOT walk on a non-ENOENT failure (e.g. permission denied)', () => {
    const { registry, calls } = mockRegistry(() => {
      const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      return err;
    });
    expect(() =>
      resolveAndSpawn(
        {
          ptyRegistry: registry,
          getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
        },
        { providerId: 'claude', cwd: '/tmp' },
      ),
    ).toThrow(ProviderLaunchError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('claude');
  });
});
