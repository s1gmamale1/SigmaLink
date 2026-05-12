// V1.1 Provider Launcher Façade — unit tests.
//
// Framework: node:test (matches the existing in-tree spec for
// `mcp-config-writer.spec.ts`). No new test runner needed.
//
// What we cover:
//   1. BUG-V1.1-01-PROV — `comingSoon` providers silently swap to their
//      `fallbackProviderId` at spawn. v1.2.4 ships no comingSoon row in the
//      default registry, but the capability is retained for future stubs and
//      tested against a synthetic fixture below.
//   2. BUG-V1.1-05-PROV — ENOENT walk through `altCommands` until one works.
//   3. BUG-V1.1-06-PROV — `autoApproveFlag` appended when `autoApprove=true`.
//   4. BUG-V1.1-07-PROV — legacy gate refuses spawn when `showLegacy=false`.
//
// We mock `PtyRegistry` with a tiny stub: `create()` calls the configured
// behaviour and returns a fake `SessionRecord`. We don't need to round-trip
// through node-pty because the façade's contract is "ask the registry to
// spawn and propagate failures" — node-pty itself is exercised in
// `local-pty` integration tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAndSpawn,
  ProviderLaunchError,
  type LauncherDeps,
} from '../launcher';
import type { AgentProviderDefinition } from '../../../../shared/providers';
import type { SessionRecord } from '../../pty/registry';

// ── Test helpers ────────────────────────────────────────────────────────

function makeFakeSession(id = 'sess-1'): SessionRecord {
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
    // Ring buffer + unsubs are read-only from the façade's perspective; the
    // tests cast to `unknown` to keep the stub minimal.
    buffer: { snapshot: () => '', append: () => undefined, clear: () => undefined } as unknown as SessionRecord['buffer'],
    unsubData: () => undefined,
    unsubExit: () => undefined,
  };
}

interface MockSpawnArgs {
  command: string;
  args: string[];
}

function makeMockRegistry(
  behaviour: (input: MockSpawnArgs) => SessionRecord | Error,
): {
  registry: LauncherDeps['ptyRegistry'];
  calls: MockSpawnArgs[];
} {
  const calls: MockSpawnArgs[] = [];
  const registry = {
    create(input: { providerId: string; command: string; args: string[]; cwd: string; cols: number; rows: number }) {
      const captured = { command: input.command, args: input.args };
      calls.push(captured);
      const result = behaviour(captured);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as LauncherDeps['ptyRegistry'];
  return { registry, calls };
}

function makeProviderRegistry(
  defs: AgentProviderDefinition[],
): (id: string) => AgentProviderDefinition | undefined {
  return (id) => defs.find((d) => d.id === id);
}

// Minimal provider definitions so each test owns its own registry shape and
// we don't accidentally regress on the production registry.

const claudeProvider: AgentProviderDefinition = {
  id: 'claude',
  name: 'Claude',
  description: '',
  command: 'claude',
  altCommands: ['claude.cmd'],
  args: [],
  autoApproveFlag: '--dangerously-skip-permissions',
  color: '#000',
  icon: '',
  installHint: 'npm i -g @anthropic-ai/claude-code',
};

// Synthetic comingSoon provider used to exercise the fallback machinery. The
// v1.2.4 shipping registry no longer includes such a row; this fixture keeps
// the launcher façade's swap path under test for future stubs.
const comingSoonStub: AgentProviderDefinition = {
  id: 'future-cli',
  name: 'Future CLI',
  description: '',
  command: 'future-cli',
  args: [],
  color: '#000',
  icon: '',
  installHint: '',
  comingSoon: true,
  fallbackProviderId: 'claude',
};

// Synthetic legacy provider used to exercise the showLegacy gate. The v1.2.4
// shipping registry no longer includes a legacy row.
const legacyStub: AgentProviderDefinition = {
  id: 'legacy-cli',
  name: 'Legacy CLI',
  description: '',
  command: 'legacy-cli',
  args: [],
  color: '#000',
  icon: '',
  installHint: '',
  legacy: true,
};

// ── Tests ────────────────────────────────────────────────────────────────

test('BUG-V1.1-01: comingSoon provider falls back to its fallbackProviderId at spawn', () => {
  const { registry, calls } = makeMockRegistry(() => makeFakeSession('s-cs'));
  const result = resolveAndSpawn(
    {
      ptyRegistry: registry,
      getProvider: makeProviderRegistry([comingSoonStub, claudeProvider]),
    },
    { providerId: 'future-cli', cwd: '/tmp' },
  );
  assert.equal(result.providerRequested, 'future-cli');
  assert.equal(result.providerEffective, 'claude');
  assert.equal(result.fallbackOccurred, true);
  assert.equal(result.commandUsed, 'claude');
  // The PTY registry was asked to spawn `claude`, not the comingSoon stub.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'claude');
});

test('BUG-V1.1-05: ENOENT on `claude` walks `claude.cmd` and succeeds', () => {
  // The first attempt throws ENOENT; the second (altCommands[0]) succeeds.
  let attempt = 0;
  const { registry, calls } = makeMockRegistry(() => {
    attempt += 1;
    if (attempt === 1) {
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      return err;
    }
    return makeFakeSession('s-cmd');
  });
  const result = resolveAndSpawn(
    {
      ptyRegistry: registry,
      getProvider: makeProviderRegistry([claudeProvider]),
    },
    { providerId: 'claude', cwd: '/tmp' },
  );
  assert.equal(result.commandUsed, 'claude.cmd');
  assert.equal(result.fallbackOccurred, false);
  assert.deepEqual(
    calls.map((c) => c.command),
    ['claude', 'claude.cmd'],
  );
});

test('BUG-V1.1-05: every candidate ENOENTs → ProviderLaunchError listing tries', () => {
  const { registry } = makeMockRegistry(() =>
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
  );
  assert.throws(
    () =>
      resolveAndSpawn(
        {
          ptyRegistry: registry,
          getProvider: makeProviderRegistry([claudeProvider]),
        },
        { providerId: 'claude', cwd: '/tmp' },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ProviderLaunchError);
      assert.equal((err as ProviderLaunchError).code, 'spawn-failed');
      assert.match((err as Error).message, /claude/);
      assert.match((err as Error).message, /claude\.cmd/);
      return true;
    },
  );
});

test('BUG-V1.1-06: autoApprove=true appends the provider autoApproveFlag', () => {
  const { registry, calls } = makeMockRegistry(() => makeFakeSession('s-aa'));
  const result = resolveAndSpawn(
    {
      ptyRegistry: registry,
      getProvider: makeProviderRegistry([claudeProvider]),
    },
    { providerId: 'claude', cwd: '/tmp', autoApprove: true },
  );
  assert.deepEqual(result.argsUsed, ['--dangerously-skip-permissions']);
  assert.deepEqual(calls[0]?.args, ['--dangerously-skip-permissions']);
});

test('BUG-V1.1-06: autoApprove=false does NOT append the flag', () => {
  const { registry } = makeMockRegistry(() => makeFakeSession('s-aa2'));
  const result = resolveAndSpawn(
    {
      ptyRegistry: registry,
      getProvider: makeProviderRegistry([claudeProvider]),
    },
    { providerId: 'claude', cwd: '/tmp' },
  );
  assert.deepEqual(result.argsUsed, []);
});

test('BUG-V1.1-06: extraArgs are appended after the autoApproveFlag', () => {
  const { registry } = makeMockRegistry(() => makeFakeSession('s-extra'));
  const result = resolveAndSpawn(
    {
      ptyRegistry: registry,
      getProvider: makeProviderRegistry([claudeProvider]),
    },
    {
      providerId: 'claude',
      cwd: '/tmp',
      autoApprove: true,
      extraArgs: ['-p', 'hello world'],
    },
  );
  assert.deepEqual(result.argsUsed, [
    '--dangerously-skip-permissions',
    '-p',
    'hello world',
  ]);
});

test('BUG-V1.1-07: legacy provider refused when showLegacy=false', () => {
  const { registry, calls } = makeMockRegistry(() => makeFakeSession('should-not-spawn'));
  assert.throws(
    () =>
      resolveAndSpawn(
        {
          ptyRegistry: registry,
          getProvider: makeProviderRegistry([legacyStub]),
        },
        { providerId: 'legacy-cli', cwd: '/tmp', showLegacy: false },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ProviderLaunchError);
      assert.equal((err as ProviderLaunchError).code, 'legacy-disabled');
      return true;
    },
  );
  // Critically: the registry was never called.
  assert.equal(calls.length, 0);
});

test('BUG-V1.1-07: legacy provider allowed when showLegacy=true', () => {
  const { registry } = makeMockRegistry(() => makeFakeSession('s-legacy'));
  const result = resolveAndSpawn(
    {
      ptyRegistry: registry,
      getProvider: makeProviderRegistry([legacyStub]),
    },
    { providerId: 'legacy-cli', cwd: '/tmp', showLegacy: true },
  );
  assert.equal(result.providerEffective, 'legacy-cli');
  assert.equal(result.commandUsed, 'legacy-cli');
});

test('unknown providerId throws ProviderLaunchError(unknown-provider)', () => {
  const { registry } = makeMockRegistry(() => makeFakeSession('nope'));
  assert.throws(
    () =>
      resolveAndSpawn(
        {
          ptyRegistry: registry,
          getProvider: makeProviderRegistry([claudeProvider]),
        },
        { providerId: 'does-not-exist', cwd: '/tmp' },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ProviderLaunchError);
      assert.equal((err as ProviderLaunchError).code, 'unknown-provider');
      return true;
    },
  );
});
