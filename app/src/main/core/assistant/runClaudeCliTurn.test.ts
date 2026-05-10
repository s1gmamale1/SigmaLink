// V3-W14-002 — Unit tests for the Claude CLI turn driver.
//
// The driver is heavy on child-process plumbing; these tests inject a fake
// child via the `spawnOverride` hook so we never touch the real `claude`
// binary. Each test feeds a sequence of JSONL envelopes through stdout and
// asserts the emitted IPC events on the `assistant:state` /
// `assistant:tool-trace` channels.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  runClaudeCliTurn,
  cancelClaudeCliTurn,
  __resetProbeCache,
  type CliChildLike,
  type CliTurnHandle,
  type SpawnOverride,
} from './runClaudeCliTurn';
import { ToolTracer } from './tool-tracer';

// ── Test harness ───────────────────────────────────────────────────────────

class FakeChild extends EventEmitter implements CliChildLike {
  stdout: Readable;
  stderr: Readable;
  killed = false;
  killSignal: string | number | null = null;

  constructor(opts: { exitCode?: number | null } = {}) {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    // Auto-close stream after envelopes get pushed in tests; tests trigger
    // close manually via finish().
    this.stdout.on('end', () => {
      // surface a default exit code on stream end
      queueMicrotask(() => this.emit('close', opts.exitCode ?? 0));
    });
  }

  pushLine(json: object | string): void {
    const line = typeof json === 'string' ? json : JSON.stringify(json);
    this.stdout.push(line + '\n');
  }

  pushStderr(s: string): void {
    this.stderr.push(s);
  }

  finish(exitCode = 0): void {
    this.stdout.push(null);
    this.stderr.push(null);
    // The Readable 'end' handler above emits the close event. Override the
    // exit code on demand by emitting close directly.
    queueMicrotask(() => this.emit('close', exitCode));
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    // Spawn the close event so the readline loop drains.
    queueMicrotask(() => {
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit('close', null);
    });
    return true;
  }
}

interface CapturedEvent {
  channel: string;
  payload: Record<string, unknown>;
}

function makeDeps() {
  const events: CapturedEvent[] = [];
  return {
    events,
    emit: (channel: string, payload: unknown) => {
      events.push({ channel, payload: payload as Record<string, unknown> });
    },
  };
}

let turnCounter = 0;
function makeTurn(): CliTurnHandle {
  turnCounter += 1;
  return {
    conversationId: `conv-test-${turnCounter}`,
    turnId: `turn-test-${turnCounter}`,
    cancelled: false,
  };
}

const fakeProbe = async () => ({
  found: true,
  resolvedPath: '/fake/bin/claude',
  version: '2.1.138',
});

const noProbe = async () => ({ found: false });

const fixedSysPrompt = () => 'system-prompt-test';

beforeEach(() => {
  __resetProbeCache();
});

afterEach(() => {
  __resetProbeCache();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runClaudeCliTurn', () => {
  it('returns no-binary when probe fails (does not spawn)', async () => {
    const deps = makeDeps();
    const out = await runClaudeCliTurn(makeTurn(), 'hi', deps, {
      probeOverride: noProbe,
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toBe('no-binary');
    // No state events should be emitted on the no-binary path — caller
    // falls back to the stub which owns its own UX.
    expect(deps.events.length).toBe(0);
  });

  it('forwards text deltas and emits final/standby on success', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const spawnOverride: SpawnOverride = () => child;

    const turnPromise = runClaudeCliTurn(makeTurn(), 'hi', deps, {
      probeOverride: fakeProbe,
      spawnOverride,
      buildSystemPrompt: fixedSysPrompt,
    });

    // Drive the canned envelopes asynchronously so the driver gets a chance
    // to attach its readline listeners before we push.
    await new Promise((r) => setImmediate(r));

    child.pushLine({ type: 'system', subtype: 'init' });
    child.pushLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    child.pushLine({
      type: 'result',
      subtype: 'success',
      result: 'hello',
      is_error: false,
      total_cost_usd: 0.0001,
      usage: { input_tokens: 6, output_tokens: 1 },
    });
    child.finish(0);

    const out = await turnPromise;
    expect(out.handled).toBe(true);

    const states = deps.events
      .filter((e) => e.channel === 'assistant:state')
      .map((e) => e.payload);

    // First state event is "thinking", then deltas, then receiving switches
    // somewhere in the middle, then a final + standby.
    expect(states[0].kind).toBe('state');
    expect(states[0].state).toBe('thinking');

    const deltas = states.filter((s) => s.kind === 'delta').map((s) => s.delta);
    expect(deltas.join('')).toBe('hello');

    const final = states.find((s) => s.kind === 'final');
    expect(final).toBeDefined();
    expect(final?.text).toBe('hello');
    expect(final?.usage).toEqual({ input_tokens: 6, output_tokens: 1 });

    const standby = states.find((s) => s.kind === 'state' && s.state === 'standby');
    expect(standby).toBeDefined();
  });

  it('routes tool_use envelopes through the tracer', async () => {
    const deps = makeDeps();
    const tracer = new ToolTracer();
    const traced: Record<string, unknown>[] = [];
    tracer.setEmitter((channel, payload) => {
      if (channel === 'assistant:tool-trace')
        traced.push(payload as Record<string, unknown>);
    });

    const child = new FakeChild();
    const spawnOverride: SpawnOverride = () => child;

    const turnPromise = runClaudeCliTurn(
      makeTurn(),
      'list swarms',
      { ...deps, tracer },
      { probeOverride: fakeProbe, spawnOverride, buildSystemPrompt: fixedSysPrompt },
    );

    await new Promise((r) => setImmediate(r));

    child.pushLine({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Calling tool…' },
          {
            type: 'tool_use',
            id: 'toolu_test_1',
            name: 'roll_call',
            input: { workspaceId: 'ws-x' },
          },
        ],
      },
    });
    child.pushLine({
      type: 'result',
      subtype: 'success',
      result: 'Calling tool…',
      is_error: false,
    });
    child.finish(0);

    await turnPromise;

    expect(traced.length).toBe(1);
    expect(traced[0].name).toBe('roll_call');
    expect(traced[0].id).toBe('toolu_test_1');
    expect(traced[0].args).toEqual({ workspaceId: 'ws-x' });
    expect(traced[0].ok).toBe(true);
    expect((traced[0].result as { fromCli: boolean }).fromCli).toBe(true);
  });

  it('emits an error envelope when result.is_error is true', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const turnPromise = runClaudeCliTurn(makeTurn(), 'hi', deps, {
      probeOverride: fakeProbe,
      spawnOverride: () => child,
      buildSystemPrompt: fixedSysPrompt,
    });

    await new Promise((r) => setImmediate(r));

    child.pushLine({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'rate limit hit',
    });
    child.finish(0);

    await turnPromise;

    const states = deps.events
      .filter((e) => e.channel === 'assistant:state')
      .map((e) => e.payload);
    const errEvt = states.find((s) => s.kind === 'error');
    expect(errEvt).toBeDefined();
    expect(errEvt?.message).toBe('rate limit hit');
    // standby still fires so the renderer settles the orb.
    const standby = states.find((s) => s.kind === 'state' && s.state === 'standby');
    expect(standby).toBeDefined();
    // The error message is also surfaced as a delta so legacy renderers
    // (which only handle delta + state) show the text.
    const deltaTexts = states.filter((s) => s.kind === 'delta').map((s) => s.delta);
    expect(deltaTexts.join('')).toContain('rate limit hit');
  });

  it('cancel mid-stream kills the child process', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const turn = makeTurn();
    const turnPromise = runClaudeCliTurn(turn, 'hi', deps, {
      probeOverride: fakeProbe,
      spawnOverride: () => child,
      buildSystemPrompt: fixedSysPrompt,
    });

    await new Promise((r) => setImmediate(r));

    child.pushLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'partial…' }] },
    });
    // Give the readline interface a tick to deliver the line before we
    // cancel, so the child registry actually contains the entry.
    await new Promise((r) => setTimeout(r, 5));
    // The driver sets cancelled=true via the controller; mimic that here.
    turn.cancelled = true;
    const killed = cancelClaudeCliTurn(turn.turnId);
    expect(killed).toBe(true);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe('SIGTERM');

    await turnPromise;

    const states = deps.events
      .filter((e) => e.channel === 'assistant:state')
      .map((e) => e.payload);
    // Cancelled standby — the driver's close handler fires once kill drains
    // the streams.
    const cancelStandby = states.find(
      (s) => s.kind === 'state' && s.state === 'standby' && s.cancelled === true,
    );
    expect(cancelStandby).toBeDefined();
  });

  it('emits error envelope when child exits non-zero without a result', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const turnPromise = runClaudeCliTurn(makeTurn(), 'hi', deps, {
      probeOverride: fakeProbe,
      spawnOverride: () => child,
      buildSystemPrompt: fixedSysPrompt,
    });

    await new Promise((r) => setImmediate(r));

    child.pushStderr('boom: missing API key\n');
    child.finish(1);

    await turnPromise;

    const states = deps.events
      .filter((e) => e.channel === 'assistant:state')
      .map((e) => e.payload);
    const errEvt = states.find((s) => s.kind === 'error');
    expect(errEvt).toBeDefined();
    expect(errEvt?.message as string).toMatch(/exited 1/);
    expect(errEvt?.message as string).toMatch(/boom/);
  });

  it('caches the probe result across calls (only probes once)', async () => {
    const deps = makeDeps();
    let probeCalls = 0;
    const counted = async () => {
      probeCalls += 1;
      return { found: true, resolvedPath: '/fake/bin/claude', version: '2.1.0' };
    };

    const child1 = new FakeChild();
    const turn1 = runClaudeCliTurn(makeTurn(), 'a', deps, {
      probeOverride: counted,
      spawnOverride: () => child1,
      buildSystemPrompt: fixedSysPrompt,
    });
    await new Promise((r) => setImmediate(r));
    child1.pushLine({ type: 'result', subtype: 'success', result: 'ok' });
    child1.finish(0);
    await turn1;

    const child2 = new FakeChild();
    const turn2 = runClaudeCliTurn(makeTurn(), 'b', deps, {
      probeOverride: counted,
      spawnOverride: () => child2,
      buildSystemPrompt: fixedSysPrompt,
    });
    await new Promise((r) => setImmediate(r));
    child2.pushLine({ type: 'result', subtype: 'success', result: 'ok' });
    child2.finish(0);
    await turn2;

    expect(probeCalls).toBe(1);
  });

  it('forwards non-JSON stdout lines as raw deltas', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const turnPromise = runClaudeCliTurn(makeTurn(), 'hi', deps, {
      probeOverride: fakeProbe,
      spawnOverride: () => child,
      buildSystemPrompt: fixedSysPrompt,
    });

    await new Promise((r) => setImmediate(r));

    // A garbage line should not crash the parser; it's surfaced as a delta.
    child.stdout.push('not-valid-json\n');
    child.pushLine({ type: 'result', subtype: 'success', result: 'ok' });
    child.finish(0);

    await turnPromise;

    const deltas = deps.events
      .filter((e) => e.channel === 'assistant:state' && e.payload.kind === 'delta')
      .map((e) => e.payload.delta as string);
    expect(deltas.join('')).toContain('not-valid-json');
  });
});
