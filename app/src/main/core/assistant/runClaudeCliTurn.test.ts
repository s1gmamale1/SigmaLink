// V3-W14-002 — Unit tests for the Claude CLI turn driver.
//
// The driver is heavy on child-process plumbing; these tests inject a fake
// child via the `spawnOverride` hook so we never touch the real `claude`
// binary. Each test feeds a sequence of JSONL envelopes through stdout and
// asserts the emitted IPC events on the `assistant:state` /
// `assistant:tool-trace` channels.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  stdinLines: string[] = [];
  killed = false;
  killSignal: string | number | null = null;

  constructor(opts: { exitCode?: number | null } = {}) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinLines.push(chunk.toString());
        callback();
      },
    });
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

async function waitForStdinLines(child: FakeChild, count: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (child.stdinLines.length >= count) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${count} stdin lines`);
}

async function waitForSpawnCount(children: FakeChild[], count: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (children.length >= count) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${count} spawned children`);
}

function parseToolResultLine(line: string): {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
} {
  const env = JSON.parse(line) as {
    type: string;
    message: { content: Array<{ tool_use_id: string; content: string; is_error?: boolean }> };
  };
  expect(env.type).toBe('user');
  return env.message.content[0];
}

beforeEach(() => {
  __resetProbeCache();
});

afterEach(() => {
  __resetProbeCache();
  vi.doUnmock('./conversations');
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

  it('dispatches a tool_use and writes a matching tool_result to stdin', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const turnPromise = runClaudeCliTurn(
      makeTurn(),
      'launch',
      {
        ...deps,
        dispatchTool: async (name, args) => {
          calls.push({ name, args });
          return { sessionId: 'sess-1', provider: 'codex', paneIndex: 4 };
        },
      },
      { probeOverride: fakeProbe, spawnOverride: () => child, buildSystemPrompt: fixedSysPrompt },
    );

    await new Promise((r) => setImmediate(r));
    child.pushLine({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_launch_1',
            name: 'launch_pane',
            input: {
              workspaceRoot: '/tmp/project',
              provider: 'codex',
              count: 1,
              initialPrompt: 'Introduce yourself.',
            },
          },
        ],
      },
    });

    await waitForStdinLines(child, 1);
    child.pushLine({ type: 'result', subtype: 'success', result: 'done', is_error: false });
    child.finish(0);
    await turnPromise;

    expect(calls).toEqual([
      {
        name: 'launch_pane',
        args: {
          workspaceRoot: '/tmp/project',
          provider: 'codex',
          count: 1,
          initialPrompt: 'Introduce yourself.',
        },
      },
    ]);
    const result = parseToolResultLine(child.stdinLines[0]);
    expect(result.tool_use_id).toBe('toolu_launch_1');
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      sessionId: 'sess-1',
      provider: 'codex',
      paneIndex: 4,
    });
  });

  it('writes an error tool_result for an unknown tool_use', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const calls: string[] = [];
    const turnPromise = runClaudeCliTurn(
      makeTurn(),
      'unknown',
      {
        ...deps,
        dispatchTool: async (name) => {
          calls.push(name);
          return { ok: true };
        },
      },
      { probeOverride: fakeProbe, spawnOverride: () => child, buildSystemPrompt: fixedSysPrompt },
    );

    await new Promise((r) => setImmediate(r));
    child.pushLine({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_unknown_1',
            name: 'not_a_sigma_tool',
            input: { value: 1 },
          },
        ],
      },
    });

    await waitForStdinLines(child, 1);
    child.pushLine({ type: 'result', subtype: 'success', result: 'handled', is_error: false });
    child.finish(0);
    await turnPromise;

    expect(calls).toEqual([]);
    const result = parseToolResultLine(child.stdinLines[0]);
    expect(result.tool_use_id).toBe('toolu_unknown_1');
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: 'unknown_tool',
      name: 'not_a_sigma_tool',
    });
  });

  it('writes an error tool_result when dispatchTool throws', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const turnPromise = runClaudeCliTurn(
      makeTurn(),
      'roll',
      {
        ...deps,
        dispatchTool: async () => {
          throw new Error('handler failed');
        },
      },
      { probeOverride: fakeProbe, spawnOverride: () => child, buildSystemPrompt: fixedSysPrompt },
    );

    await new Promise((r) => setImmediate(r));
    child.pushLine({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_throw_1',
            name: 'roll_call',
            input: { workspaceId: 'ws-1' },
          },
        ],
      },
    });

    await waitForStdinLines(child, 1);
    child.pushLine({ type: 'result', subtype: 'success', result: 'handled', is_error: false });
    child.finish(0);
    await turnPromise;

    const result = parseToolResultLine(child.stdinLines[0]);
    expect(result.tool_use_id).toBe('toolu_throw_1');
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ error: 'handler failed' });
  });

  it('dispatches multiple tool_use blocks and writes results in input order', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const calls: string[] = [];
    const turnPromise = runClaudeCliTurn(
      makeTurn(),
      'list',
      {
        ...deps,
        dispatchTool: async (name) => {
          calls.push(name);
          return { name };
        },
      },
      { probeOverride: fakeProbe, spawnOverride: () => child, buildSystemPrompt: fixedSysPrompt },
    );

    await new Promise((r) => setImmediate(r));
    child.pushLine({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_sessions',
            name: 'list_active_sessions',
            input: { workspaceId: 'ws-1' },
          },
          {
            type: 'tool_use',
            id: 'toolu_workspaces',
            name: 'list_workspaces',
            input: {},
          },
        ],
      },
    });

    await waitForStdinLines(child, 2);
    child.pushLine({ type: 'result', subtype: 'success', result: 'handled', is_error: false });
    child.finish(0);
    await turnPromise;

    expect(calls).toEqual(['list_active_sessions', 'list_workspaces']);
    const first = parseToolResultLine(child.stdinLines[0]);
    const second = parseToolResultLine(child.stdinLines[1]);
    expect(first.tool_use_id).toBe('toolu_sessions');
    expect(second.tool_use_id).toBe('toolu_workspaces');
    expect(JSON.parse(first.content)).toEqual({ name: 'list_active_sessions' });
    expect(JSON.parse(second.content)).toEqual({ name: 'list_workspaces' });
  });

  it('records Ruflo trajectory start, tool step, and success end when available', async () => {
    const deps = makeDeps();
    const child = new FakeChild();
    const calls: Array<{ method: string; input: unknown }> = [];
    const ruflo = {
      trajectoryStart: async (input: { task: string; agent?: string }) => {
        calls.push({ method: 'start', input });
        return 'traj-test';
      },
      trajectoryStep: async (input: {
        trajectoryId: string;
        action: string;
        result?: string;
        quality?: number;
      }) => {
        calls.push({ method: 'step', input });
      },
      trajectoryEnd: async (input: {
        trajectoryId: string;
        success: boolean;
        feedback?: string;
      }) => {
        calls.push({ method: 'end', input });
      },
    };
    const turnPromise = runClaudeCliTurn(
      makeTurn(),
      'launch one pane',
      {
        ...deps,
        ruflo,
        dispatchTool: async () => ({ ok: true }),
      },
      { probeOverride: fakeProbe, spawnOverride: () => child, buildSystemPrompt: fixedSysPrompt },
    );

    await new Promise((r) => setImmediate(r));
    child.pushLine({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_launch_traj',
            name: 'launch_pane',
            input: { workspaceRoot: '/tmp/project', provider: 'codex' },
          },
        ],
      },
    });
    await waitForStdinLines(child, 1);
    child.pushLine({ type: 'result', subtype: 'success', result: 'done', is_error: false });
    child.finish(0);
    await turnPromise;

    expect(calls.map((c) => c.method)).toEqual(['start', 'step', 'end']);
    expect(calls[0].input).toEqual({ task: 'launch one pane', agent: 'sigma-assistant' });
    expect(calls[1].input).toMatchObject({
      trajectoryId: 'traj-test',
      action: 'launch_pane',
      quality: 1,
    });
    expect(calls[2].input).toEqual({
      trajectoryId: 'traj-test',
      success: true,
      feedback: 'done',
    });
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

  describe('W-2 v1.4.0 session resume runtime', () => {
    const validSessionId = '11111111-2222-4333-8444-555555555555';

    async function importWithConversationDao(overrides: {
      getClaudeSessionId?: (conversationId: string) => string | null;
      setClaudeSessionId?: (conversationId: string, claudeSessionId: string | null) => void;
      appendMessage?: (input: {
        conversationId: string;
        role: string;
        content: string;
        toolCallId?: string | null;
      }) => Record<string, unknown>;
    }) {
      vi.resetModules();
      vi.doMock('./conversations', () => ({
        getConversation: (id: string) => ({
          id,
          workspaceId: 'ws-runtime',
          kind: 'assistant',
          createdAt: 1,
        }),
        appendMessage:
          overrides.appendMessage ??
          ((input: {
            conversationId: string;
            role: string;
            content: string;
            toolCallId?: string | null;
          }) => ({
            id: 'assistant-message-runtime',
            conversationId: input.conversationId,
            role: input.role,
            content: input.content,
            toolCallId: input.toolCallId ?? null,
            createdAt: 2,
          })),
        getClaudeSessionId: overrides.getClaudeSessionId,
        setClaudeSessionId: overrides.setClaudeSessionId,
      }));
      return import('./runClaudeCliTurn');
    }

    it('passes --resume when the conversation has a valid prior Claude session id', async () => {
      const mod = await importWithConversationDao({
        getClaudeSessionId: () => validSessionId,
      });
      mod.__resetProbeCache();
      const deps = makeDeps();
      const child = new FakeChild();
      let capturedArgs: string[] | null = null;

      const turnPromise = mod.runClaudeCliTurn(makeTurn(), 'resume please', deps, {
        probeOverride: fakeProbe,
        spawnOverride: () => child,
        buildSystemPrompt: fixedSysPrompt,
        onSpawnArgs: (_bin, args) => {
          capturedArgs = args.slice();
        },
      });

      await new Promise((r) => setImmediate(r));
      child.pushLine({ type: 'result', subtype: 'success', result: 'ok', is_error: false });
      child.finish(0);
      await turnPromise;

      expect(capturedArgs).not.toBeNull();
      const args = capturedArgs as unknown as string[];
      expect(args.slice(0, 2)).toEqual(['--resume', validSessionId]);
    });

    it('captures system.init session_id through the conversations DAO', async () => {
      const setClaudeSessionId = vi.fn();
      const mod = await importWithConversationDao({ setClaudeSessionId });
      mod.__resetProbeCache();
      const deps = makeDeps();
      const child = new FakeChild();
      const turn = makeTurn();

      const turnPromise = mod.runClaudeCliTurn(turn, 'capture', deps, {
        probeOverride: fakeProbe,
        spawnOverride: () => child,
        buildSystemPrompt: fixedSysPrompt,
      });

      await new Promise((r) => setImmediate(r));
      child.pushLine({ type: 'system', subtype: 'init', session_id: validSessionId });
      child.pushLine({ type: 'result', subtype: 'success', result: 'ok', is_error: false });
      child.finish(0);
      await turnPromise;

      expect(setClaudeSessionId).toHaveBeenCalledWith(turn.conversationId, validSessionId);
    });

    it('creates the assistant message with a turn-scoped in-flight sentinel', async () => {
      const appendMessage = vi.fn((input: {
        conversationId: string;
        role: string;
        content: string;
        toolCallId?: string | null;
      }) => ({
        id: 'assistant-message-runtime',
        ...input,
        createdAt: 2,
      }));
      const mod = await importWithConversationDao({ appendMessage });
      mod.__resetProbeCache();
      const deps = makeDeps();
      const child = new FakeChild();
      const turn = makeTurn();

      const turnPromise = mod.runClaudeCliTurn(turn, 'sentinel', deps, {
        probeOverride: fakeProbe,
        spawnOverride: () => child,
        buildSystemPrompt: fixedSysPrompt,
      });

      await new Promise((r) => setImmediate(r));
      child.pushLine({ type: 'result', subtype: 'success', result: 'ok', is_error: false });
      child.finish(0);
      await turnPromise;

      expect(appendMessage).toHaveBeenCalledWith({
        conversationId: turn.conversationId,
        role: 'assistant',
        content: '',
        toolCallId: `sigma-in-flight:${turn.turnId}`,
      });
    });

    it('retries once without --resume on likely resume failure and clears the stale id', async () => {
      const setClaudeSessionId = vi.fn();
      const mod = await importWithConversationDao({
        getClaudeSessionId: () => validSessionId,
        setClaudeSessionId,
      });
      mod.__resetProbeCache();
      const deps = makeDeps();
      const children: FakeChild[] = [];
      const spawnedArgs: string[][] = [];

      const turnPromise = mod.runClaudeCliTurn(makeTurn(), 'recover', deps, {
        probeOverride: fakeProbe,
        spawnOverride: (_bin, args) => {
          spawnedArgs.push(args.slice());
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        buildSystemPrompt: fixedSysPrompt,
      });

      await waitForSpawnCount(children, 1);
      children[0].pushLine({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'cannot find session',
      });
      children[0].finish(1);

      await waitForSpawnCount(children, 2);
      children[1].pushLine({ type: 'result', subtype: 'success', result: 'ok', is_error: false });
      children[1].finish(0);
      await turnPromise;

      expect(spawnedArgs[0].slice(0, 2)).toEqual(['--resume', validSessionId]);
      expect(spawnedArgs[1]).not.toContain('--resume');
      expect(setClaudeSessionId).toHaveBeenCalledWith(expect.any(String), null);

      const states = deps.events
        .filter((e) => e.channel === 'assistant:state')
        .map((e) => e.payload);
      const errors = states.filter((s) => s.kind === 'error');
      expect(errors).toEqual([]);
      const final = states.find((s) => s.kind === 'final');
      expect(final?.text).toBe('ok');
    });
  });

  // ──────────────────────────────────────────── BUG-V1.1.2-01: MCP wiring ──

  describe('BUG-V1.1.2-01 — passes --mcp-config when mcpHost is wired', () => {
    it('adds --mcp-config + --strict-mcp-config and writes a sigma-host stdio entry', async () => {
      // Stage a fake server-entry file so writeSigmaHostMcpConfig accepts it.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-host-test-'));
      const serverEntry = path.join(tmpDir, 'mcp-sigma-host-server.cjs');
      fs.writeFileSync(serverEntry, '// stub\n', 'utf8');
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-host-ws-'));

      try {
        const deps = makeDeps();
        const child = new FakeChild();
        let capturedArgs: string[] | null = null;
        const turnPromise = runClaudeCliTurn(
          makeTurn(),
          'hi',
          {
            ...deps,
            mcpHost: {
              serverEntry,
              socketPath: '/tmp/sigma-host-test.sock',
              workspaceRoot,
            },
          },
          {
            probeOverride: fakeProbe,
            spawnOverride: () => child,
            buildSystemPrompt: fixedSysPrompt,
            onSpawnArgs: (_bin, args) => {
              capturedArgs = args.slice();
            },
          },
        );

        await new Promise((r) => setImmediate(r));
        child.pushLine({ type: 'result', subtype: 'success', result: 'ok' });
        child.finish(0);
        await turnPromise;

        expect(capturedArgs).not.toBeNull();
        const args = capturedArgs as unknown as string[];
        const cfgIdx = args.indexOf('--mcp-config');
        expect(cfgIdx).toBeGreaterThan(-1);
        const cfgPath = args[cfgIdx + 1];
        expect(typeof cfgPath).toBe('string');
        expect(args).toContain('--strict-mcp-config');
        // The config file should live under the workspace's .claude-flow dir.
        expect(cfgPath).toContain(path.join(workspaceRoot, '.claude-flow'));
        expect(fs.existsSync(cfgPath)).toBe(true);

        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
          mcpServers: Record<
            string,
            {
              type: string;
              command: string;
              args: string[];
              env: Record<string, string>;
            }
          >;
        };
        expect(cfg.mcpServers['sigma-host']).toBeDefined();
        expect(cfg.mcpServers['sigma-host'].type).toBe('stdio');
        expect(cfg.mcpServers['sigma-host'].args).toEqual([serverEntry]);
        expect(cfg.mcpServers['sigma-host'].env.SIGMA_HOST_SOCKET).toBe('/tmp/sigma-host-test.sock');
        expect(cfg.mcpServers['sigma-host'].env.SIGMA_HOST_AUTOBOOT).toBe('1');
        expect(cfg.mcpServers['sigma-host'].env.ELECTRON_RUN_AS_NODE).toBe('1');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('omits --mcp-config when mcpHost is not wired (v1.1.1 parity)', async () => {
      const deps = makeDeps();
      const child = new FakeChild();
      let capturedArgs: string[] | null = null;
      const turnPromise = runClaudeCliTurn(makeTurn(), 'hi', deps, {
        probeOverride: fakeProbe,
        spawnOverride: () => child,
        buildSystemPrompt: fixedSysPrompt,
        onSpawnArgs: (_bin, args) => {
          capturedArgs = args.slice();
        },
      });

      await new Promise((r) => setImmediate(r));
      child.pushLine({ type: 'result', subtype: 'success', result: 'ok' });
      child.finish(0);
      await turnPromise;

      expect(capturedArgs).not.toBeNull();
      const args = capturedArgs as unknown as string[];
      expect(args).not.toContain('--mcp-config');
      expect(args).not.toContain('--strict-mcp-config');
    });

    it('skips --mcp-config when the bundled server entry is missing on disk', async () => {
      const deps = makeDeps();
      const child = new FakeChild();
      let capturedArgs: string[] | null = null;
      const turnPromise = runClaudeCliTurn(
        makeTurn(),
        'hi',
        {
          ...deps,
          mcpHost: {
            serverEntry: '/does/not/exist/mcp-sigma-host-server.cjs',
            socketPath: '/tmp/sigma-host-test.sock',
          },
        },
        {
          probeOverride: fakeProbe,
          spawnOverride: () => child,
          buildSystemPrompt: fixedSysPrompt,
          onSpawnArgs: (_bin, args) => {
            capturedArgs = args.slice();
          },
        },
      );

      await new Promise((r) => setImmediate(r));
      child.pushLine({ type: 'result', subtype: 'success', result: 'ok' });
      child.finish(0);
      await turnPromise;

      const args = capturedArgs as unknown as string[];
      expect(args).not.toContain('--mcp-config');
      // The turn still succeeds — Sigma host is best-effort, never blocking.
    });
  });

});
