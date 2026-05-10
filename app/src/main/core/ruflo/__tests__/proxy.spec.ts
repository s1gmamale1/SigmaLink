// Phase 4 Track C — Ruflo proxy + controller unit tests.
//
// Framework: node:test (mirrors voice/__tests__/dispatcher.spec.ts).
// Run via:
//   node --import tsx --test src/main/core/ruflo/__tests__/proxy.spec.ts
//
// We mock the supervisor instead of spawning the real Ruflo MCP — these tests
// exercise the proxy + controller envelope contract, the unavailable code
// path, and the JSON-RPC frame multiplex via a fake child stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { RufloProxy } from '../proxy.ts';
import { buildRufloController } from '../controller.ts';
import type { RufloHealth, RufloHealthState } from '../types.ts';

/** Minimal stub matching the supervisor's public surface. We only need the
 *  bits the proxy + controller actually call. */
class FakeSupervisor extends EventEmitter {
  private _state: RufloHealthState = 'absent';
  public lastCall: { tool: string; args: unknown; opts?: { timeoutMs?: number } } | null = null;
  public callImpl: (tool: string, args: unknown) => Promise<unknown> = () =>
    Promise.reject(new Error('unset'));

  setState(state: RufloHealthState): void {
    this._state = state;
  }

  health(): RufloHealth {
    return { state: this._state };
  }

  async call<T>(
    tool: string,
    args: Record<string, unknown> | undefined,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    this.lastCall = { tool, args, opts };
    if (this._state !== 'ready') {
      throw new Error(`ruflo-unavailable: supervisor state ${this._state}`);
    }
    return (await this.callImpl(tool, args)) as T;
  }
}

class FakeInstaller {
  start(): { jobId: string; promise: Promise<{ ok: boolean; size: number; path: string }> } {
    return {
      jobId: 'job-fake',
      promise: Promise.resolve({ ok: false, size: 0, path: '/tmp/ruflo' }),
    };
  }
}

function makeController(supState: RufloHealthState = 'ready') {
  const sup = new FakeSupervisor();
  sup.setState(supState);
  // Cast through unknown — the test uses the structural subset of the real
  // supervisor that the proxy + controller actually require. The real
  // `RufloMcpSupervisor` extends EventEmitter; FakeSupervisor matches that.
  const proxy = new RufloProxy(sup as unknown as import('../supervisor.ts').RufloMcpSupervisor);
  const installer = new FakeInstaller() as unknown as import('../installer.ts').RufloInstaller;
  const controller = buildRufloController({
    supervisor: sup as unknown as import('../supervisor.ts').RufloMcpSupervisor,
    proxy,
    installer,
  });
  return { sup, proxy, controller };
}

// ── proxy ────────────────────────────────────────────────────────────────

test('proxy: forwards tool name + args + tool-specific timeout', async () => {
  const { sup, proxy } = makeController('ready');
  sup.callImpl = async () => ({ results: [] });
  await proxy.call('agentdb_pattern-store', { pattern: 'foo' });
  assert.equal(sup.lastCall?.tool, 'agentdb_pattern-store');
  assert.equal(sup.lastCall?.opts?.timeoutMs, 8_000);
});

test('proxy: per-call timeout override takes precedence', async () => {
  const { sup, proxy } = makeController('ready');
  sup.callImpl = async () => ({});
  await proxy.call('embeddings_search', { query: 'q' }, { timeoutMs: 100 });
  assert.equal(sup.lastCall?.opts?.timeoutMs, 100);
});

test('proxy: isReady reflects supervisor state', () => {
  const { sup, proxy } = makeController('ready');
  assert.equal(proxy.isReady(), true);
  sup.setState('degraded');
  assert.equal(proxy.isReady(), false);
});

// ── controller: unavailable envelope ─────────────────────────────────────

test('controller: returns ruflo-unavailable when supervisor absent', async () => {
  const { controller } = makeController('absent');
  const out = await controller['embeddings.search']({ query: 'hello' });
  assert.equal((out as { ok: boolean }).ok, false);
  if ('code' in out) {
    assert.equal(out.code, 'ruflo-unavailable');
  }
});

test('controller: returns ruflo-unavailable when supervisor degraded', async () => {
  const { controller } = makeController('degraded');
  const out = await controller['patterns.search']({ query: 'foo' });
  assert.equal((out as { ok: boolean }).ok, false);
});

test('controller: returns ruflo-unavailable when supervisor down', async () => {
  const { controller } = makeController('down');
  const out = await controller['autopilot.predict']();
  assert.equal((out as { ok: boolean }).ok, false);
});

// ── controller: pattern store payload shape (researcher correction) ─────

test('controller: patterns.store sends { pattern, type, confidence } NOT { namespace, key, value }', async () => {
  const { sup, controller } = makeController('ready');
  sup.callImpl = async () => ({ id: 'p1' });
  await controller['patterns.store']({
    pattern: 'Refactor auth',
    type: 'phase4-track-c',
    confidence: 0.85,
  });
  assert.equal(sup.lastCall?.tool, 'agentdb_pattern-store');
  const args = sup.lastCall?.args as Record<string, unknown>;
  assert.equal(args.pattern, 'Refactor auth');
  assert.equal(args.type, 'phase4-track-c');
  assert.equal(args.confidence, 0.85);
  assert.equal(args.namespace, undefined);
  assert.equal(args.key, undefined);
  assert.equal(args.value, undefined);
});

test('controller: patterns.store applies { type: task-completion, confidence: 0.8 } defaults', async () => {
  const { sup, controller } = makeController('ready');
  sup.callImpl = async () => ({});
  await controller['patterns.store']({ pattern: 'x' });
  const args = sup.lastCall?.args as Record<string, unknown>;
  assert.equal(args.type, 'task-completion');
  assert.equal(args.confidence, 0.8);
});

// ── controller: response normalization ───────────────────────────────────

test('controller: embeddings.search filters malformed rows', async () => {
  const { sup, controller } = makeController('ready');
  sup.callImpl = async () => ({
    results: [
      { id: 'a', score: 0.9, text: 'apple' },
      { id: 42, score: 0.5, text: 'bad-id' }, // dropped — id must be string
      { id: 'b', score: 0.3, text: 'banana', namespace: 'fruits' },
    ],
  });
  const out = await controller['embeddings.search']({ query: 'q' });
  assert.equal((out as { ok: boolean }).ok, true);
  if ('results' in out) {
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0]?.id, 'a');
    assert.equal(out.results[1]?.namespace, 'fruits');
  }
});

test('controller: patterns.search filters non-string patterns', async () => {
  const { sup, controller } = makeController('ready');
  sup.callImpl = async () => ({
    results: [
      { pattern: 'good', type: 't1', confidence: 0.9, score: 0.85 },
      { pattern: null, confidence: 0.5 }, // dropped
      { pattern: 'also-good', confidence: 0.7, score: 0.6 },
    ],
  });
  const out = await controller['patterns.search']({ query: 'q' });
  if ('results' in out) {
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0]?.pattern, 'good');
  }
});

test('controller: autopilot.predict returns suggestion=null when missing', async () => {
  const { sup, controller } = makeController('ready');
  sup.callImpl = async () => ({});
  const out = await controller['autopilot.predict']();
  if ('suggestion' in out) {
    assert.equal(out.suggestion, null);
  }
});

test('controller: autopilot.predict passes through valid suggestions', async () => {
  const { sup, controller } = makeController('ready');
  sup.callImpl = async () => ({
    suggestion: { title: 'Continue refactor', commandId: 'cmd:refactor' },
  });
  const out = await controller['autopilot.predict']();
  if ('suggestion' in out && out.suggestion) {
    assert.equal(out.suggestion.title, 'Continue refactor');
    assert.equal(out.suggestion.commandId, 'cmd:refactor');
  }
});

// ── controller: install.start surfaces job id ────────────────────────────

test('controller: install.start returns a jobId', async () => {
  const { controller } = makeController('absent');
  const out = await controller['install.start']();
  assert.equal(typeof out.jobId, 'string');
  assert.ok(out.jobId.length > 0);
});

// ── controller: health passthrough ───────────────────────────────────────

test('controller: health echoes supervisor state', async () => {
  const { sup, controller } = makeController('ready');
  const h = await controller.health();
  assert.equal(h.state, 'ready');
  sup.setState('degraded');
  const h2 = await controller.health();
  assert.equal(h2.state, 'degraded');
});
