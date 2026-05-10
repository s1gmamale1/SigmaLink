// V1.1 — SigmaVoice dispatcher unit tests.
//
// Framework: node:test (the same runner used by `mcp-config-writer.spec.ts`).
// Run via `node --import tsx --test src/main/core/voice/__tests__/dispatcher.spec.ts`
// once tsx wiring is set up; for now the spec file exists so a future
// `pnpm test` script can pick it up automatically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, dispatch } from '../dispatcher.ts';

test('classify: spawns a coder with implicit count', () => {
  const out = classify('spawn a coder');
  assert.equal(out.intent, 'create_swarm');
  assert.equal(out.controller, 'swarms.create');
  assert.deepEqual(out.args, { count: 1, role: 'coder' });
});

test('classify: spawns three testers (word number)', () => {
  const out = classify('spawn three testers');
  assert.equal(out.intent, 'create_swarm');
  assert.deepEqual(out.args, { count: 3, role: 'tester' });
});

test('classify: launches 5 reviewers (digit number)', () => {
  const out = classify('launch 5 reviewers');
  assert.equal(out.intent, 'create_swarm');
  assert.deepEqual(out.args, { count: 5, role: 'reviewer' });
});

test('classify: navigation intent strips trailing words', () => {
  const out = classify('open the swarm room');
  assert.equal(out.intent, 'app.navigate');
  assert.deepEqual(out.args, { pane: 'swarm' });
});

test('classify: navigation accepts "switch to memory"', () => {
  const out = classify('switch to memory');
  assert.equal(out.intent, 'app.navigate');
  assert.deepEqual(out.args, { pane: 'memory' });
});

test('classify: broadcast captures quoted message + target', () => {
  const out = classify(`send "stand down everyone" to coordinator`);
  assert.equal(out.intent, 'swarms.broadcast');
  assert.deepEqual(out.args, { message: 'stand down everyone', target: 'coordinator' });
});

test('classify: broadcast with no target', () => {
  const out = classify(`broadcast 'all hands on deck'`);
  assert.equal(out.intent, 'swarms.broadcast');
  assert.deepEqual(out.args, { message: 'all hands on deck' });
});

test('classify: roll call (canonical)', () => {
  const out = classify('roll call');
  assert.equal(out.intent, 'swarms.rollCall');
  assert.deepEqual(out.args, {});
});

test('classify: roll call ("who is running")', () => {
  const out = classify("who's running");
  assert.equal(out.intent, 'swarms.rollCall');
});

test('classify: free-text fallback for arbitrary speech', () => {
  const out = classify('what is the meaning of life');
  assert.equal(out.intent, 'assistant.freeform');
  assert.equal(out.controller, 'assistant.send');
  assert.equal((out.args as { text: string }).text, 'what is the meaning of life');
});

test('classify: empty transcript routes to freeform with empty body', () => {
  const out = classify('   ');
  assert.equal(out.intent, 'assistant.freeform');
  assert.equal((out.args as { text: string }).text, '');
});

test('classify: case-insensitive prefix', () => {
  const out = classify('SPAWN Two CODERS');
  assert.equal(out.intent, 'create_swarm');
  assert.deepEqual(out.args, { count: 2, role: 'coder' });
});

// ─── dispatch() routing ────────────────────────────────────────────────────

test('dispatch: emits voice:dispatch-echo even when routing fails', async () => {
  const events: Array<{ event: string; payload: unknown }> = [];
  const result = await dispatch('what is the meaning of life', {
    emit: (event, payload) => events.push({ event, payload }),
    resolveWorkspaceId: () => null, // no workspace → routing fails
    resolveSwarmId: () => null,
    controllers: {},
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, 'voice:dispatch-echo');
  assert.equal(result.ok, false);
  assert.equal(result.intent, 'assistant.freeform');
});

test('dispatch: routes broadcast through swarmBroadcast handler', async () => {
  const calls: Array<{ swarmId: string; body: string }> = [];
  const result = await dispatch(`send "ack" to coder`, {
    emit: () => {},
    resolveSwarmId: () => 'swarm-123',
    controllers: {
      swarmBroadcast: async (args) => {
        calls.push(args);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ swarmId: 'swarm-123', body: 'ack' }]);
});

test('dispatch: roll call without active swarm returns notRouted', async () => {
  const result = await dispatch('roll call', {
    emit: () => {},
    resolveSwarmId: () => null,
    controllers: {
      swarmRollCall: async () => undefined,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no active swarm');
});

test('dispatch: free-text routes to assistant.send with workspace', async () => {
  const calls: Array<{ workspaceId: string; prompt: string }> = [];
  const result = await dispatch('hey assistant, summarise the last commit', {
    emit: () => {},
    resolveWorkspaceId: () => 'ws-1',
    controllers: {
      assistantSend: async (args) => {
        calls.push(args);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.workspaceId, 'ws-1');
});

test('dispatch: navigate fires app.navigate handler synchronously', async () => {
  const calls: Array<{ pane: string }> = [];
  const result = await dispatch('open browser', {
    emit: () => {},
    controllers: {
      appNavigate: (args) => {
        calls.push(args);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ pane: 'browser' }]);
});
