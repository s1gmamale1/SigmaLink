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

// G-1 fix: Gemini fresh-spawn must never receive --session-id
const geminiProvider: AgentProviderDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  description: "Google's Gemini CLI",
  command: 'gemini',
  altCommands: ['gemini.cmd'],
  args: [],
  initialPromptFlag: '-i',
  autoApproveFlag: '--yolo',
  color: '#4285F4',
  icon: 'gem',
  installHint: 'npm i -g @google/gemini-cli',
};

describe('resolveAndSpawn — Gemini fresh-spawn args (G-1 fix)', () => {
  it('gemini fresh spawn does not include --session-id', () => {
    const { registry, calls } = mockRegistry(() => makeFakeSession('gemini-sess'));

    resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'gemini' ? geminiProvider : undefined),
      },
      { providerId: 'gemini', cwd: '/tmp' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).not.toContain('--session-id');
    // The preassignedExternalSessionId must be absent for gemini
    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'gemini' ? geminiProvider : undefined),
      },
      { providerId: 'gemini', cwd: '/tmp' },
    );
    expect(result.preassignedExternalSessionId).toBeUndefined();
  });

  it('gemini resume with --resume latest does not prepend --session-id', () => {
    const { registry, calls } = mockRegistry(() => makeFakeSession('gemini-resume'));

    resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'gemini' ? geminiProvider : undefined),
      },
      {
        providerId: 'gemini',
        cwd: '/tmp',
        extraArgs: ['--resume', 'latest'],
      },
    );

    expect(calls[0]?.args).toEqual(['--resume', 'latest']);
    expect(calls[0]?.args).not.toContain('--session-id');
  });
});

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

  it('H-9: walks to altCommands in shell-first mode (fallback is mode-agnostic)', () => {
    // H-9: the alt-command fallback used to be dead in shell-first mode because
    // spawnLocalPty injected the binary into a live shell instead of pre-flighting
    // it, so a missing primary never threw ENOENT and the walk never advanced.
    // spawnLocalPty now pre-flights in shell-first mode too, so the registry
    // throws ENOENT and resolveAndSpawn's walk advances — identically to direct
    // mode. This test pins the launcher contract: spawnMode is forwarded and the
    // walk is mode-agnostic.
    let attempt = 0;
    const capturedSpawnModes: Array<'direct' | 'shell-first' | undefined> = [];
    const calls: MockSpawn[] = [];
    const registry = {
      create(input: {
        command: string;
        args: string[];
        spawnMode?: 'direct' | 'shell-first';
      }) {
        calls.push({ command: input.command, args: input.args });
        capturedSpawnModes.push(input.spawnMode);
        attempt += 1;
        if (attempt === 1) {
          // Primary 'claude' missing → ENOENT, exactly as spawnLocalPty's
          // shell-first pre-flight now surfaces it.
          throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
        }
        return makeFakeSession('s-alt-shellfirst');
      },
    } as unknown as LauncherDeps['ptyRegistry'];

    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
      },
      { providerId: 'claude', cwd: '/tmp', spawnMode: 'shell-first' },
    );

    expect(result.commandUsed).toBe('claude.cmd');
    expect(calls.map((c) => c.command)).toEqual(['claude', 'claude.cmd']);
    // Every attempt carried the shell-first mode through to the registry.
    expect(capturedSpawnModes).toEqual(['shell-first', 'shell-first']);
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

  it('preassignedSessionId does NOT suppress pre-assignment (shouldPreAssign returns true for claude)', () => {
    // v1.5.5-A: fresh spawns pass preassignedSessionId; shouldPreAssign must
    // still return true so --session-id gets injected for claude/gemini.
    const { registry, calls } = mockRegistry(() => makeFakeSession('s-fresh'));

    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
      },
      {
        providerId: 'claude',
        cwd: '/tmp',
        preassignedSessionId: 'my-prealloc-uuid',
      },
    );

    // --session-id must be present (pre-assign fired).
    expect(calls[0]?.args[0]).toBe('--session-id');
    expect(result.preassignedExternalSessionId).toBeDefined();
  });

  it('sessionId suppresses pre-assignment (shouldPreAssign returns false — resume path unchanged)', () => {
    const { registry, calls } = mockRegistry(() => makeFakeSession('s-resume'));

    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
      },
      {
        providerId: 'claude',
        cwd: '/tmp',
        sessionId: 'existing-db-id',
      },
    );

    // No --session-id prepended when resuming.
    expect(calls[0]?.args).not.toContain('--session-id');
    expect(result.preassignedExternalSessionId).toBeUndefined();
  });

  it('does not prepend --session-id when caller is resuming an existing Claude session', () => {
    const { registry, calls } = mockRegistry(() => makeFakeSession('s-resume'));

    const result = resolveAndSpawn(
      {
        ptyRegistry: registry,
        getProvider: (id) => (id === 'claude' ? claudeProvider : undefined),
      },
      {
        providerId: 'claude',
        cwd: '/tmp',
        extraArgs: ['--resume', '01234567-89ab-4cde-9f01-23456789abcd'],
      },
    );

    expect(calls[0]?.args).toEqual([
      '--resume',
      '01234567-89ab-4cde-9f01-23456789abcd',
    ]);
    expect(result.preassignedExternalSessionId).toBeUndefined();
  });
});
