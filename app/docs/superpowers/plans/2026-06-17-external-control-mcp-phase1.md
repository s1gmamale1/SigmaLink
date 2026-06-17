# External Control MCP — Phase 1 (Gateway) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose SigmaLink's control plane (terminals/panes/workspaces) to external MCP clients (external Claude Code, Hermes, OpenClaw) over a local stdio-bridge-to-socket transport, under a supervised-autonomy authorization policy.

**Architecture:** A new `net` **Control MCP Host** socket server in `main` (mirrors `mcp-host-sigma.ts`) accepts connections from a tiny stdio MCP bridge that external clients spawn (`claude mcp add … -- node mcp-sigma-control-server.cjs`). The host **forces `origin:'external'`**, requires a token handshake, and forwards `tools.invoke` to the existing `invokeAssistantTool`. A new **provider-aware authorization policy** classifies each call FREE / ESCALATE / DENY; ESCALATE routes a `confirmDangerous` to the operator. New control tools + a `wait_for_pane` observation primitive (fed by a main-side `SIGMA::PROMPT` watcher) complete the surface. Process-singleton discipline: **main spawns no per-client process** (the bridge is the client's child).

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly` — NO constructor param-properties, NO enums), Node `net` (Unix socket / Windows named pipe), zod, vitest. Hand-rolled newline-delimited JSON-RPC (no MCP SDK / express / ws in-tree). DB tests use MockDb/fakes (`better-sqlite3` won't load under vitest).

**Reference:** spec `docs/superpowers/specs/2026-06-17-external-control-mcp-and-hermes-design.md`. Verbatim existing interfaces are in §"Extracted Interfaces" at the bottom — read it before coding.

---

## File Structure

**Wave 1 — new isolated modules (parallelizable in separate worktrees, no shared-file edits):**
- `src/main/core/control/authz-external.ts` — pure FREE/ESCALATE/DENY policy. (Task 1)
- `src/main/core/control/authz-external.test.ts`
- `src/main/core/control/control-config.ts` — enable/freeze flags, bearer token, socket path. (Task 2)
- `src/main/core/control/control-config.test.ts`
- `src/main/core/pty/prompt-sink.ts` — main-side `SIGMA::PROMPT`/idle/exit watcher + `wait()`. (Task 3)
- `src/main/core/pty/prompt-sink.test.ts`
- `src/main/core/control/control-mcp-host.ts` — `net` socket server, token handshake, forces `origin:'external'`. (Task 4)
- `src/main/core/control/control-mcp-host.test.ts`

**Wave 2 — integration into existing (hot) files (sequential, single lane):**
- `src/main/core/assistant/controller.ts` — `origin:'external'` gate branch + provider resolver injection. (Task 5)
- `src/main/core/assistant/tools.ts` + `tool-catalogue.ts` + `system-prompt.ts` — new control tools. (Task 6)
- `src/main/core/assistant/observe-tools.ts` (new) — `wait_for_pane` + `read_pane_since` tool handlers. (Task 6)
- `src/main/core/pty/registry.ts` — feed the prompt-sink from `onData`/exit. (Task 7)
- `src/main/core/control/escalation.ts` (new) — external `confirmDangerous` → operator. (Task 8)
- `src/main/core/control/control-rpc.ts` (new controller) + `rpc-router.ts` + `src/shared/rpc-channels.ts` — control RPC + boot wiring + quit-order. (Task 9)
- `src/main/control/mcp-sigma-control-server.ts` → built `mcp-sigma-control-server.cjs` — external stdio bridge. (Task 10)
- Renderer settings surface for the `claude mcp add` command. (Task 11)

---

## WAVE 1 — Parallel new modules

### Task 1: Provider-aware authorization policy

**Files:**
- Create: `src/main/core/control/authz-external.ts`
- Test: `src/main/core/control/authz-external.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/control/authz-external.test.ts
import { describe, it, expect } from 'vitest';
import {
  classifyExternal,
  AGENT_PROVIDERS,
  EXTERNAL_ESCALATE_TOOLS,
  PROVIDER_GATED_TOOLS,
} from './authz-external';

describe('classifyExternal', () => {
  it('kill-switch denies everything, even reads', () => {
    expect(classifyExternal({ toolId: 'read_pane', targetProvider: null, killSwitch: true })).toBe('deny');
    expect(classifyExternal({ toolId: 'list_workspaces', targetProvider: null, killSwitch: true })).toBe('deny');
  });

  it('reads/lists/launch are free', () => {
    for (const id of ['read_pane', 'read_pane_since', 'list_active_sessions', 'list_workspaces', 'wait_for_pane', 'launch_pane', 'open_workspace', 'set_pane_label', 'switch_workspace', 'focus_pane']) {
      expect(classifyExternal({ toolId: id, targetProvider: null, killSwitch: false }), id).toBe('free');
    }
  });

  it('close_pane / close_workspace / browser_navigate escalate', () => {
    for (const id of ['close_pane', 'close_workspace', 'browser_navigate']) {
      expect(classifyExternal({ toolId: id, targetProvider: null, killSwitch: false }), id).toBe('escalate');
    }
  });

  it('prompt_agent/send_keys are free into an AGENT pane, escalate into a shell', () => {
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: 'claude', killSwitch: false })).toBe('free');
    expect(classifyExternal({ toolId: 'send_keys', targetProvider: 'codex', killSwitch: false })).toBe('free');
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: 'shell', killSwitch: false })).toBe('escalate');
    expect(classifyExternal({ toolId: 'send_keys', targetProvider: 'bash', killSwitch: false })).toBe('escalate');
  });

  it('unknown/missing provider for a gated tool fails safe (escalate)', () => {
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: null, killSwitch: false })).toBe('escalate');
    expect(classifyExternal({ toolId: 'prompt_agent', targetProvider: 'mystery', killSwitch: false })).toBe('escalate');
  });

  // MEMBERSHIP REGRESSION (per plan-base-drift lesson): lock exact set contents.
  it('escalate/gated/agent sets have exactly the expected members', () => {
    expect([...EXTERNAL_ESCALATE_TOOLS].sort()).toEqual(['browser_navigate', 'close_pane', 'close_workspace']);
    expect([...PROVIDER_GATED_TOOLS].sort()).toEqual(['prompt_agent', 'send_keys']);
    expect([...AGENT_PROVIDERS].sort()).toEqual(['claude', 'codex', 'gemini', 'kimi', 'opencode']);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx vitest run src/main/core/control/authz-external.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/main/core/control/authz-external.ts
//
// Supervised-autonomy authorization policy for origin:'external' tool calls.
// PURE function — no I/O, no DB, no electron import (must load under vitest).
// Spec §6. The gate in controller.ts resolves `targetProvider` (the provider of
// the session a prompt_agent/send_keys targets) and the kill-switch, then asks
// this function for the verdict.

export type ExternalVerdict = 'free' | 'escalate' | 'deny';

export interface ClassifyInput {
  /** Canonical (post-alias) tool id. */
  toolId: string;
  /** Provider of the target session for provider-gated tools; null if N/A or unknown. */
  targetProvider: string | null;
  /** When true (operator froze external control) every call is denied. */
  killSwitch: boolean;
}

/** Agent CLIs — writing to these panes is talking to an agent (FREE). */
export const AGENT_PROVIDERS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
  'kimi',
  'opencode',
]);

/** Irreversible / high-blast-radius tools — always escalate to the operator. */
export const EXTERNAL_ESCALATE_TOOLS: ReadonlySet<string> = new Set([
  'close_pane',
  'close_workspace',
  'browser_navigate',
]);

/** Tools whose danger depends on the TARGET pane's provider (agent vs shell). */
export const PROVIDER_GATED_TOOLS: ReadonlySet<string> = new Set([
  'prompt_agent',
  'send_keys',
]);

export function classifyExternal(input: ClassifyInput): ExternalVerdict {
  if (input.killSwitch) return 'deny';
  if (EXTERNAL_ESCALATE_TOOLS.has(input.toolId)) return 'escalate';
  if (PROVIDER_GATED_TOOLS.has(input.toolId)) {
    return input.targetProvider !== null && AGENT_PROVIDERS.has(input.targetProvider)
      ? 'free'
      : 'escalate';
  }
  return 'free';
}
```

- [ ] **Step 4: Run test, verify pass** — `npx vitest run src/main/core/control/authz-external.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(control): provider-aware external authorization policy`

---

### Task 2: Control config (flags, token, socket path)

**Files:**
- Create: `src/main/core/control/control-config.ts`
- Test: `src/main/core/control/control-config.test.ts`

Uses the `KvLike` / `CredentialStoreLike` interfaces (see Extracted Interfaces §6). Tests inject in-memory fakes.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/control/control-config.test.ts
import { describe, it, expect } from 'vitest';
import {
  KV_CONTROL_MCP_ENABLED, KV_CONTROL_MCP_FROZEN,
  isControlEnabled, isControlFrozen, setControlEnabled, setControlFrozen,
  ensureBearerToken, getBearerToken, controlSocketPath,
} from './control-config';

function fakeKv() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
}
function fakeCreds() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    remove: async (k: string) => m.delete(k),
    isEncryptionAvailable: () => true,
  };
}

describe('control-config', () => {
  it('enabled/frozen default off and toggle via kv === "1"', () => {
    const kv = fakeKv();
    expect(isControlEnabled(kv)).toBe(false);
    expect(isControlFrozen(kv)).toBe(false);
    setControlEnabled(kv, true);
    setControlFrozen(kv, true);
    expect(kv.get(KV_CONTROL_MCP_ENABLED)).toBe('1');
    expect(kv.get(KV_CONTROL_MCP_FROZEN)).toBe('1');
    expect(isControlEnabled(kv)).toBe(true);
    expect(isControlFrozen(kv)).toBe(true);
    setControlEnabled(kv, false);
    expect(isControlEnabled(kv)).toBe(false);
  });

  it('ensureBearerToken generates once and is stable; getBearerToken reads it', async () => {
    const creds = fakeCreds();
    expect(await getBearerToken(creds)).toBeNull();
    const t1 = await ensureBearerToken(creds);
    expect(t1).toHaveLength(64); // 32 random bytes hex
    const t2 = await ensureBearerToken(creds);
    expect(t2).toBe(t1); // stable
    expect(await getBearerToken(creds)).toBe(t1);
  });

  it('controlSocketPath is platform-appropriate and stable', () => {
    const p = controlSocketPath('/tmp/ud', 'win32');
    expect(p).toMatch(/^\\\\\.\\pipe\\sigmalink-control-/);
    const u = controlSocketPath('/tmp/ud', 'darwin');
    expect(u).toBe('/tmp/ud/control.sock');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
// src/main/core/control/control-config.ts
import * as crypto from 'node:crypto';
import * as path from 'node:path';

// erasableSyntaxOnly: declare interfaces locally (no param-properties).
export interface KvLike { get(key: string): string | null; set(key: string, value: string): void; }
export interface CredentialStoreLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<boolean>;
  isEncryptionAvailable(): boolean;
}

export const KV_CONTROL_MCP_ENABLED = 'control.mcp.enabled';
export const KV_CONTROL_MCP_FROZEN = 'control.mcp.frozen';
export const CRED_CONTROL_BEARER = 'control.mcp.bearerToken';

export function isControlEnabled(kv: KvLike): boolean { return kv.get(KV_CONTROL_MCP_ENABLED) === '1'; }
export function isControlFrozen(kv: KvLike): boolean { return kv.get(KV_CONTROL_MCP_FROZEN) === '1'; }
export function setControlEnabled(kv: KvLike, on: boolean): void { kv.set(KV_CONTROL_MCP_ENABLED, on ? '1' : '0'); }
export function setControlFrozen(kv: KvLike, on: boolean): void { kv.set(KV_CONTROL_MCP_FROZEN, on ? '1' : '0'); }

export async function getBearerToken(creds: CredentialStoreLike): Promise<string | null> {
  return creds.get(CRED_CONTROL_BEARER);
}
export async function ensureBearerToken(creds: CredentialStoreLike): Promise<string> {
  const existing = await creds.get(CRED_CONTROL_BEARER);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  await creds.set(CRED_CONTROL_BEARER, token);
  return token;
}
export async function rotateBearerToken(creds: CredentialStoreLike): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await creds.set(CRED_CONTROL_BEARER, token);
  return token;
}

export function controlSocketPath(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha1').update(userDataDir).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\sigmalink-control-${hash}`;
  }
  return path.join(userDataDir, 'control.sock');
}

/** Constant-time token compare (avoid timing oracle on the handshake). */
export function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(control): control config (flags, bearer token, socket path)`

---

### Task 3: Main-side wait-for-pane watcher (`PromptSink`)

**Files:**
- Create: `src/main/core/pty/prompt-sink.ts`
- Test: `src/main/core/pty/prompt-sink.test.ts`

Reuses the node-safe `swarms/protocol.ts` (see Extracted Interfaces §8). No electron/DB import.

- [ ] **Step 1: Write the failing test** (fake timers for idle/timeout)

```ts
// src/main/core/pty/prompt-sink.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptSink } from './prompt-sink';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PromptSink', () => {
  it('resolves on SIGMA::PROMPT with the parsed payload', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'prompt', timeoutMs: 5000 });
    sink.feed('s1', 'some output\n');
    sink.feed('s1', 'SIGMA::PROMPT {"question":"Pick one","type":"single","choices":["a","b"]}\n');
    const r = await p;
    expect(r).toEqual({ sessionId: 's1', reason: 'prompt', prompt: { question: 'Pick one', type: 'single', choices: ['a', 'b'] } });
  });

  it('resolves on idle after idleMs of no data', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'idle', timeoutMs: 5000, idleMs: 800 });
    sink.feed('s1', 'working...');
    await vi.advanceTimersByTimeAsync(799);
    sink.feed('s1', 'more'); // resets idle timer
    await vi.advanceTimersByTimeAsync(800);
    const r = await p;
    expect(r).toMatchObject({ sessionId: 's1', reason: 'idle' });
  });

  it('resolves on exit', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'exit', timeoutMs: 5000 });
    sink.noteExit('s1');
    expect(await p).toMatchObject({ sessionId: 's1', reason: 'exit' });
  });

  it('wait-for-any resolves on the first ready session', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1', 's2'], until: 'prompt', timeoutMs: 5000 });
    sink.feed('s2', 'SIGMA::PROMPT {"question":"Q","type":"single","choices":["y"]}\n');
    expect(await p).toMatchObject({ sessionId: 's2', reason: 'prompt' });
  });

  it('resolves reason:timeout when nothing happens', async () => {
    const sink = new PromptSink();
    const p = sink.wait({ sessionIds: ['s1'], until: 'prompt', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ reason: 'timeout', sessionId: null });
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
// src/main/core/pty/prompt-sink.ts
//
// Main-side watcher: scans raw PTY chunks (fed from PtyRegistry.onData) for
// SIGMA::PROMPT protocol lines and tracks idle/exit, so a main-process tool
// (wait_for_pane) can block until a pane needs input / settles / exits.
// Reuses the node-safe parser in ../swarms/protocol (NO electron/DB import).

import {
  ProtocolLineBuffer,
  parseProtocolLine,
  isPromptPayload,
  type PromptPayload,
} from '../swarms/protocol';

export type PaneWaitReason = 'prompt' | 'idle' | 'exit' | 'timeout';

export interface PaneWaitResult {
  sessionId: string | null; // null only for reason:'timeout'
  reason: PaneWaitReason;
  prompt?: PromptPayload;
}

interface Waiter {
  sessionIds: Set<string>;
  until: 'prompt' | 'idle' | 'exit';
  idleMs: number;
  resolve: (r: PaneWaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface SessionState {
  buf: ProtocolLineBuffer;
  lastPrompt: PromptPayload | null;
}

export class PromptSink {
  private readonly sessions = new Map<string, SessionState>();
  private readonly waiters = new Set<Waiter>();

  feed(sessionId: string, data: string): void {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { buf: new ProtocolLineBuffer(), lastPrompt: null };
      this.sessions.set(sessionId, st);
    }
    // Any data resets idle timers for waiters watching this session.
    for (const w of this.waiters) {
      if (w.until === 'idle' && w.sessionIds.has(sessionId)) this.armIdle(w, sessionId);
    }
    st.buf.push(data, (line) => {
      const parsed = parseProtocolLine(line);
      if (!parsed || parsed.verb !== 'PROMPT' || !isPromptPayload(parsed.payload)) return;
      st!.lastPrompt = parsed.payload;
      this.fire(sessionId, { sessionId, reason: 'prompt', prompt: parsed.payload }, 'prompt');
    });
  }

  noteExit(sessionId: string): void {
    this.fire(sessionId, { sessionId, reason: 'exit' }, 'exit');
    this.sessions.delete(sessionId);
  }

  wait(opts: {
    sessionIds: string[];
    until: 'prompt' | 'idle' | 'exit';
    timeoutMs: number;
    idleMs?: number;
  }): Promise<PaneWaitResult> {
    return new Promise<PaneWaitResult>((resolve) => {
      const w: Waiter = {
        sessionIds: new Set(opts.sessionIds),
        until: opts.until,
        idleMs: opts.idleMs ?? 800,
        resolve,
        timer: setTimeout(() => this.settle(w, { sessionId: null, reason: 'timeout' }), opts.timeoutMs),
        idleTimers: new Map(),
      };
      this.waiters.add(w);
      if (opts.until === 'idle') for (const id of opts.sessionIds) this.armIdle(w, id);
    });
  }

  private armIdle(w: Waiter, sessionId: string): void {
    const prev = w.idleTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    w.idleTimers.set(
      sessionId,
      setTimeout(() => this.settle(w, { sessionId, reason: 'idle' }), w.idleMs),
    );
  }

  private fire(sessionId: string, result: PaneWaitResult, kind: 'prompt' | 'exit'): void {
    for (const w of [...this.waiters]) {
      if (w.until === kind && w.sessionIds.has(sessionId)) this.settle(w, result);
    }
  }

  private settle(w: Waiter, result: PaneWaitResult): void {
    if (!this.waiters.has(w)) return;
    this.waiters.delete(w);
    clearTimeout(w.timer);
    for (const t of w.idleTimers.values()) clearTimeout(t);
    w.resolve(result);
  }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(pty): main-side SIGMA::PROMPT/idle/exit watcher for wait_for_pane`

---

### Task 4: Control MCP Host (socket server)

**Files:**
- Create: `src/main/core/control/control-mcp-host.ts`
- Test: `src/main/core/control/control-mcp-host.test.ts`

Mirrors `mcp-host-sigma.ts` (Extracted Interfaces §1) but: separate socket path, **mandatory token handshake**, **forces `origin:'external'`**, kill-switch-aware, injects an escalation `confirmDangerous`, tracks live sockets for clean teardown (NOT a spawn — leak-safe).

- [ ] **Step 1: Write the failing test** (real Unix socket on a temp path; skip on win32)

```ts
// src/main/core/control/control-mcp-host.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ControlMcpHost } from './control-mcp-host';

const sock = () => path.join(os.tmpdir(), `sl-ctl-${Math.floor(Math.random() * 1e9)}.sock`);

function rpc(socket: net.Socket, obj: unknown): Promise<any> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (c: Buffer) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) { socket.off('data', onData); resolve(JSON.parse(buf.slice(0, nl))); }
    };
    socket.on('data', onData);
    socket.write(JSON.stringify(obj) + '\n');
  });
}

describe('ControlMcpHost', () => {
  it('rejects tools.invoke before a valid handshake', async () => {
    const socketPath = sock();
    const invoke = vi.fn();
    const host = new ControlMcpHost({
      socketPath, getToken: () => 'secret', isFrozen: () => false,
      resolveInvoker: () => invoke, escalate: async () => true,
    });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'tools.invoke', params: { name: 'read_pane', args: {} } });
    expect(res.error.message).toMatch(/handshake|unauthorized/i);
    expect(invoke).not.toHaveBeenCalled();
    c.destroy(); host.stop();
  });

  it('bad token is rejected and the socket is closed', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const res = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'WRONG', label: 'x' } });
    expect(res.error.message).toMatch(/unauthorized/i);
    host.stop();
  });

  it('after handshake, forwards tools.invoke with origin:external forced', async () => {
    const socketPath = sock();
    const invoke = vi.fn(async () => ({ ok: true, result: { screen: 'hi' } }));
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => invoke, escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    const hi = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'hermes' } });
    expect(hi.result.ok).toBe(true);
    const res = await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools.invoke', params: { name: 'read_pane', args: { sessionId: 's1' } } });
    expect(res.result).toEqual({ ok: true, result: { screen: 'hi' } });
    const call = invoke.mock.calls[0][0];
    expect(call.origin).toBe('external');
    expect(typeof call.confirmDangerous).toBe('function');
    c.destroy(); host.stop();
  });

  it('frozen host rejects authenticated calls', async () => {
    const socketPath = sock();
    let frozen = false;
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => frozen, resolveInvoker: () => vi.fn(async () => ({ ok: true, result: 1 })), escalate: async () => true });
    await host.start();
    const c = net.connect(socketPath);
    await rpc(c, { jsonrpc: '2.0', id: 1, method: 'control.hello', params: { token: 'secret', label: 'x' } });
    frozen = true;
    const res = await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools.invoke', params: { name: 'read_pane', args: {} } });
    expect(res.error.message).toMatch(/frozen/i);
    c.destroy(); host.stop();
  });

  it('tracks live connections and drops to zero after stop (no orphan)', async () => {
    const socketPath = sock();
    const host = new ControlMcpHost({ socketPath, getToken: () => 'secret', isFrozen: () => false, resolveInvoker: () => vi.fn(), escalate: async () => true });
    await host.start();
    const c1 = net.connect(socketPath); const c2 = net.connect(socketPath);
    await new Promise((r) => setTimeout(r, 30));
    expect(host.liveConnectionCount()).toBe(2);
    host.stop();
    expect(host.liveConnectionCount()).toBe(0);
    c1.destroy(); c2.destroy();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (model on `mcp-host-sigma.ts`; add handshake state per socket)

```ts
// src/main/core/control/control-mcp-host.ts
//
// External Control MCP Host — a net socket server in MAIN that accepts
// connections from the external stdio bridge (mcp-sigma-control-server.cjs).
// Mirrors mcp-host-sigma.ts but: (a) requires a token handshake, (b) FORCES
// origin:'external' on every forwarded call (a client cannot claim 'local'),
// (c) is kill-switch aware, (d) injects an escalation confirmDangerous.
// Stateless per-connection except a live-socket Set for clean teardown — MAIN
// spawns NO child per client (the bridge is the client's child) → leak-safe.

import * as net from 'node:net';
import * as fs from 'node:fs';
import { tokenEquals } from './control-config';

export interface ExternalToolInvoker {
  (input: {
    name: string;
    args: Record<string, unknown>;
    origin: 'external';
    confirmDangerous: (toolName: string, summary: string) => Promise<boolean>;
  }): Promise<{ ok: boolean; result: unknown; error?: string }>;
}

export interface ControlMcpHostOpts {
  socketPath: string;
  getToken: () => string | null;
  isFrozen: () => boolean;
  resolveInvoker: () => ExternalToolInvoker | null;
  /** Route a dangerous-action confirmation to the operator; resolve true to allow. */
  escalate: (toolName: string, summary: string, clientLabel: string) => Promise<boolean>;
  /** Optional catalogue provider for tools/list (the external-exposed subset). */
  getCatalogue?: () => unknown[];
}

interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class ControlMcpHost {
  private server: net.Server | null = null;
  private started = false;
  private readonly live = new Set<net.Socket>();
  private readonly authed = new WeakMap<net.Socket, { label: string }>();
  private readonly opts: ControlMcpHostOpts;

  constructor(opts: ControlMcpHostOpts) {
    this.opts = opts;
  }

  getSocketPath(): string { return this.opts.socketPath; }
  liveConnectionCount(): number { return this.live.size; }

  async start(): Promise<void> {
    if (this.started) return;
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.opts.socketPath); } catch { /* not there */ }
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.opts.socketPath, () => { server.off('error', reject); this.server = server; this.started = true; resolve(); });
    });
  }

  stop(): void {
    const s = this.server;
    this.server = null;
    this.started = false;
    for (const sock of [...this.live]) { try { sock.destroy(); } catch { /* ignore */ } }
    this.live.clear();
    if (s) { try { s.close(); } catch { /* ignore */ } }
    if (process.platform !== 'win32') { try { fs.unlinkSync(this.opts.socketPath); } catch { /* ignore */ } }
  }

  private handleConnection(socket: net.Socket): void {
    this.live.add(socket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (line) void this.handleLine(line, socket);
      }
    });
    socket.on('close', () => this.live.delete(socket));
    socket.on('error', () => this.live.delete(socket));
  }

  private send(socket: net.Socket, payload: unknown): void {
    try { socket.write(JSON.stringify(payload) + '\n'); } catch { /* closed */ }
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: IncomingMessage;
    try { req = JSON.parse(line) as IncomingMessage; } catch { return; }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;
    const id = req.id ?? null;
    const params = req.params ?? {};

    if (req.method === 'control.hello') {
      const token = this.opts.getToken();
      const provided = typeof params.token === 'string' ? params.token : '';
      const label = typeof params.label === 'string' ? params.label.slice(0, 64) : 'external';
      if (!token || !tokenEquals(provided, token)) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: -32001, message: 'unauthorized' } });
        socket.destroy();
        return;
      }
      this.authed.set(socket, { label });
      this.send(socket, { jsonrpc: '2.0', id, result: { ok: true } });
      return;
    }

    const session = this.authed.get(socket);
    if (!session) {
      this.send(socket, { jsonrpc: '2.0', id, error: { code: -32002, message: 'handshake required (call control.hello first)' } });
      return;
    }
    if (this.opts.isFrozen()) {
      this.send(socket, { jsonrpc: '2.0', id, error: { code: -32010, message: 'control is frozen (kill-switch engaged)' } });
      return;
    }

    if (req.method === 'tools.list') {
      this.send(socket, { jsonrpc: '2.0', id, result: { tools: this.opts.getCatalogue?.() ?? [] } });
      return;
    }
    if (req.method === 'tools.invoke') {
      const invoker = this.opts.resolveInvoker();
      if (!invoker) { this.send(socket, { jsonrpc: '2.0', id, error: { code: -32000, message: 'control host: invoker not wired' } }); return; }
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.args && typeof params.args === 'object' ? (params.args as Record<string, unknown>) : {};
      if (!name) { this.send(socket, { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools.invoke requires { name }' } }); return; }
      try {
        const out = await invoker({
          name,
          args,
          origin: 'external',
          confirmDangerous: (toolName, summary) => this.opts.escalate(toolName, summary, session.label),
        });
        this.send(socket, { jsonrpc: '2.0', id, result: out });
      } catch (err) {
        this.send(socket, { jsonrpc: '2.0', id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
    this.send(socket, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(control): Control MCP Host socket server (token handshake, forces origin:external)`

---

## WAVE 2 — Integration (sequential, single lane; depends on Wave 1 merged)

### Task 5: External branch in the authorization gate

**Files:** Modify `src/main/core/assistant/controller.ts` (the `ToolOrigin` union at :90 and `invokeAssistantTool` :170-301). Test: `src/main/core/assistant/controller-external-gate.test.ts`.

- [ ] **Step 1:** Extend the union (`controller.ts:90`):
```ts
export type ToolOrigin = 'local' | 'telegram' | 'external';
```

- [ ] **Step 2: Write the failing test.** The gate's provider resolution + kill-switch are injected so the test needs no DB. Add to the assistant-controller deps two optional injectables: `resolveSessionProvider?: (sessionId: string) => string | null` and `controlFrozen?: () => boolean`. Test builds a controller with fakes and asserts: external + `read_pane` → runs; external + `close_pane` without approval → `ok:false`; external + `prompt_agent` into a `shell` provider without approval → `ok:false`; external + `prompt_agent` into a `claude` provider → runs; kill-switch on → every external call `ok:false`. (Mirror the existing `authorization.test.ts` harness — it already builds a controller with fake deps; copy its setup.)

- [ ] **Step 3: Implement** — after the existing telegram gate block (`controller.ts:~213`), add:
```ts
    // Supervised-autonomy gate for origin:'external' (Control MCP). Provider-aware:
    // talking to an AGENT pane is free; close/destructive/shell-write escalates.
    if (origin === 'external') {
      const killSwitch = deps.controlFrozen ? deps.controlFrozen() : false;
      const sid = typeof (input?.args as { sessionId?: unknown })?.sessionId === 'string'
        ? ((input!.args as { sessionId: string }).sessionId)
        : null;
      const targetProvider = sid && deps.resolveSessionProvider ? deps.resolveSessionProvider(sid) : null;
      const verdict = classifyExternal({ toolId: tool.id, targetProvider, killSwitch });
      if (verdict === 'deny') {
        const error = 'External control is frozen (kill-switch engaged).';
        recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error });
        return { ok: false, result: null, error };
      }
      if (verdict === 'escalate') {
        let approved = false;
        try {
          approved = typeof input?.confirmDangerous === 'function'
            && (await input.confirmDangerous(tool.id, summarizeArgs(tool.id, input?.args ?? {}))) === true;
        } catch { approved = false; }
        if (!approved) {
          const error = 'This action needs operator confirmation and was not approved.';
          recordTrace({ ...traceBase, args: input?.args ?? {}, ok: false, result: null, error });
          return { ok: false, result: null, error };
        }
      }
    }
```
Import `classifyExternal` at the top of controller.ts. In production wiring (Task 9) inject `resolveSessionProvider` = a DB read of `agent_sessions.provider_id` and `controlFrozen` = `() => isControlFrozen(kv)`.

- [ ] **Step 4: Run → PASS.** Also run the FULL existing `authorization.test.ts` to prove telegram behavior is unchanged.
- [ ] **Step 5: Commit** — `feat(assistant): origin:external supervised-autonomy gate`

---

### Task 6: New control tools + observation tools (3-mirror + parity)

**Files:** Modify `tools.ts`, `tool-catalogue.ts`, `system-prompt.ts`; create `src/main/core/assistant/observe-tools.ts`. Test: extend `tool-catalogue.test.ts`; add `observe-tools.test.ts`.

Add tools to `TOOLS` (each via the `T(...)` helper, Extracted Interfaces §1), a matching `JorvisCatalogueEntry`, and a `TOOL_BLURB` line. The 4 parity assertions (Extracted Interfaces §5) enforce exact 3-way sync — run them after each addition. Tools and exact schemas:

- [ ] **Step 1: `open_workspace`** — `tools.ts`:
```ts
const sOpenWorkspace = z.object({ root: z.string().min(1).optional(), workspaceId: z.string().min(1).optional(), targetRoom: z.string().optional() });
// handler: resolve root|workspaceId; call the same path rpc workspaces.open uses
// (executeOpenWorkspace) via an injected ctx dep OR a direct import; emit a
// 'workspace:opened' broadcast is already done by markWorkspaceOpened. Return { ok, workspace }.
```
Catalogue entry (`tool-catalogue.ts`): `{ name: 'open_workspace', description: 'Open a workspace by root path or id (optionally landing on a room).', inputSchema: { type: 'object', required: [], properties: { root: { type: 'string' }, workspaceId: { type: 'string' }, targetRoom: { type: 'string' } } } }`. Blurb line: `  open_workspace      { root?, workspaceId?, targetRoom? }` + description.

- [ ] **Step 2: `close_workspace`** — `sClose = z.object({ workspaceId: z.string().min(1) })`; handler calls the same path as `rpc.workspaces.remove` (stops panes + deletes rows). DESTRUCTIVE — it is in `EXTERNAL_ESCALATE_TOOLS` (Task 1), no change to `DANGEROUS_REMOTE` needed (that set governs telegram). Catalogue + blurb to match.

- [ ] **Step 3: `switch_workspace`** — `z.object({ workspaceId: z.string().min(1) })`; handler emits an event the renderer turns into `SET_ACTIVE_WORKSPACE_ID` (mirror the `assistant:dispatch-echo` jumpToPane pattern, Extracted Interfaces §7 — emit `assistant:dispatch-echo` with a `focusOnly` marker, OR a new `assistant:focus-workspace` event + a `use-live-events` subscriber). Choose the new-event route; add the subscriber in `use-live-events.ts` and an EVENTS allowlist guard test.

- [ ] **Step 4: `focus_pane`** — `z.object({ sessionId: z.string().min(1), fullscreen: z.boolean().optional() })`; emit `assistant:focus-pane` → renderer dispatches `SET_ACTIVE_SESSION` (+ `SET_FOCUSED_PANE` when fullscreen). Add subscriber + guard test.

- [ ] **Step 5: `set_pane_label`** — `z.object({ sessionId: z.string().min(1), label: z.string().min(1).max(80) })`; persist the display name (same path as `rpc.panes.rename`) + broadcast `panes:session-renamed`. Return `{ ok, sessionId, label }`.

- [ ] **Step 6: `send_keys`** — `z.object({ sessionId: z.string().min(1), keys: z.array(z.string()).min(1) })`; map named keys (`Enter`→`\r`, `C-c`→`\x03`, `Up`→`\x1b[A`, `Tab`→`\t`, etc.; literal strings pass through) and `ctx.pty.write(sessionId, encoded)`. Provider-gated like `prompt_agent` (Task 1 already lists it in `PROVIDER_GATED_TOOLS`). Put the key map in a small pure helper `src/main/core/control/key-encode.ts` + its own unit test.

- [ ] **Step 7: `read_pane_since`** — in `observe-tools.ts`: `z.object({ sessionId: z.string().min(1), cursor: z.number().int().nonnegative().optional() })`. Use `ctx.pty.snapshot(sessionId)` (full scrollback string); cursor = byte offset already seen; return `{ text: snapshot.slice(cursor), cursor: snapshot.length }`. (Incremental read without a stream.)

- [ ] **Step 8: `wait_for_pane`** — in `observe-tools.ts`: `z.object({ sessionIds: z.array(z.string().min(1)).min(1), until: z.enum(['prompt','idle','exit']), timeoutMs: z.number().int().min(100).max(600000).optional() })`. Handler calls the injected `promptSink.wait({...})` (the `PromptSink` from Task 3, threaded via a new `ctx.promptSink` dep) and returns `{ sessionId, reason, prompt? , tail }` where `tail` = last ~2KB of `ctx.pty.snapshot(sessionId)`.

- [ ] **Step 9:** Add `promptSink?: { wait: PromptSink['wait'] }` to `ToolContext` (tools.ts) and thread it from the controller deps (Task 9 wires the real singleton). Add `wait_for_pane` + `read_pane_since` to `TOOLS`, catalogue, blurb.

- [ ] **Step 10: Run parity + observe tests** — `npx vitest run src/main/core/assistant/tool-catalogue.test.ts src/main/core/assistant/observe-tools.test.ts src/main/core/control/key-encode.test.ts` → PASS (all 3-way parity green).
- [ ] **Step 11: Commit** — `feat(assistant): external control tools (workspace/pane control + wait_for_pane + read_pane_since)`

---

### Task 7: Feed the PromptSink from the PTY registry

**Files:** Modify `src/main/core/pty/registry.ts` (the `onData` hook at :282-345 and the exit path). Test: extend `registry.test.ts` (or a focused new test with a fake PromptSink).

- [ ] **Step 1:** Add an optional constructor opt `promptSink?: { feed(id: string, data: string): void; noteExit(id: string): void }` (mirror the existing `PaneEventSink`/`CliExitedSink` injection idiom — do NOT import PromptSink concretely; keep registry vitest-loadable).
- [ ] **Step 2: Write the failing test** — construct a registry with a fake `promptSink`, drive a fake pty's `onData` with a chunk, assert `promptSink.feed` was called with `(id, chunk)`; drive exit, assert `noteExit(id)`.
- [ ] **Step 3: Implement** — after `this.onData(id, data)` (registry.ts:319) add `try { this.promptSink?.feed(id, data); } catch { /* never break the stream */ }`. Wire `noteExit` wherever `pty:exit` is emitted for the session. Run this as an INDEPENDENT block (NOT inside the `shell-first` sentinel conditional — SIGMA::PROMPT panes may be direct-mode).
- [ ] **Step 4: Run → PASS**, plus the FULL `registry.test.ts` + `terminal-cache.test.ts` (mock-breakage guard).
- [ ] **Step 5: Commit** — `feat(pty): feed PromptSink from registry onData/exit`

---

### Task 8: External escalation (`confirmDangerous` → operator)

**Files:** Create `src/main/core/control/escalation.ts`. Test: `escalation.test.ts`.

- [ ] **Step 1: Write the failing test** — `makeExternalConfirm({ telegram, broadcast, respondVia, timeoutMs })` returns a fn `(toolName, summary, label) => Promise<boolean>`. Tests: (a) when `telegram?.confirmAvailable()` true → delegates to `telegram.confirm(summary)`; (b) else broadcasts `control:escalation` and resolves when `respondVia` fires approve/deny; (c) timeout → resolves false.
- [ ] **Step 2: Implement** — mirror the Telegram pending-map pattern (Extracted Interfaces §7): a `Map<string, {resolve, timer}>` keyed by a generated id; broadcast `control:escalation` `{ id, toolName, summary, label }` to the renderer; expose `resolve(id, approved)` for a `control.respondEscalation` RPC; 60s default timeout → `resolve(false)`; if a Telegram bridge is enabled+running, prefer it. Fail-closed: any error → false.
- [ ] **Step 3: Run → PASS.**
- [ ] **Step 4: Commit** — `feat(control): external escalation to operator (renderer prompt + telegram fallback)`

---

### Task 9: Control RPC + boot wiring + quit-order

**Files:** Create `src/main/core/control/control-rpc.ts`; modify `src/main/rpc-router.ts` (construct + start the host; quit-order; inject controller deps; feed PromptSink into registry) and `src/shared/rpc-channels.ts` (allowlist).

- [ ] **Step 1: Control RPC controller** — `defineController({ status, enable, disable, freeze, unfreeze, rotateToken, connectCommand, respondEscalation })`. `status()` → `{ enabled, frozen, running, liveConnections, socketPath }`. `connectCommand()` → the `claude mcp add sigmalink -- node <serverEntry>` string with token env. Add each `control.*` channel to `CHANNELS` in `rpc-channels.ts` (and the `rpc-channels.test.ts` will verify parity).
- [ ] **Step 2: Boot wiring in `buildRouter`** — construct the singletons:
```ts
const promptSink = new PromptSink();                                  // pass to PtyRegistry ctor opts
const controlMcpHost = new ControlMcpHost({
  socketPath: controlSocketPath(app.getPath('userData')),
  getToken: () => controlBearerCache,                                 // loaded async at boot via ensureBearerToken
  isFrozen: () => isControlFrozen(controlKv),
  resolveInvoker: () => assistantBundle.invokeTool as ExternalToolInvoker,
  escalate: makeExternalConfirm({ telegram: telegramBridge, broadcast, respondVia: escalationResponders, timeoutMs: 60_000 }),
  getCatalogue: () => EXTERNAL_CATALOGUE,                              // the external-exposed subset of JORVIS_TOOL_CATALOGUE
});
if (isControlEnabled(controlKv)) void controlMcpHost.start().catch((e) => console.warn(`[control-mcp] start failed: ${e}`));
```
Inject `resolveSessionProvider` (DB read of `agent_sessions.provider_id`) and `controlFrozen: () => isControlFrozen(controlKv)` into the assistant controller deps (Task 5).
- [ ] **Step 3: Quit-order** — in `shutdownRouter()` (Extracted Interfaces §3), insert between `mcpHostSigma?.stop()` (~:2670) and `closeDatabase()`: `try { controlMcpHost.stop(); } catch {}`. (Stateless host → no pid to await. Hermes' process join comes in Phase 2.)
- [ ] **Step 4: Tests** — `control-rpc.test.ts` (status/enable/freeze toggles via fake kv); a lifecycle test asserting `controlMcpHost` opening/closing N connections leaves `liveConnectionCount()===0` and **never calls `child_process.spawn`** (structural: the module must not import `node:child_process`). Update `rpc-channels.test.ts` expectations.
- [ ] **Step 5: Commit** — `feat(control): control RPC + boot wiring + quit-order teardown`

---

### Task 10: External stdio MCP bridge binary

**Files:** Create `src/main/control/mcp-sigma-control-server.ts` → built to `mcp-sigma-control-server.cjs` (add to the esbuild/electron-dist build entry list alongside `mcp-jorvis-host-server.cjs`).

- [ ] **Step 1:** Locate the existing jorvis host server SOURCE (the source that builds `electron-dist/mcp-jorvis-host-server.cjs` — grep `mcp-jorvis-host-server` in build config + `src/`). Read it: it already implements the MCP wire protocol (`initialize`, `tools/list`, `tools/call`) over stdio and bridges to main's socket via `tools.invoke`.
- [ ] **Step 2:** Clone it to `mcp-sigma-control-server.ts` with these exact diffs:
  - Read `SIGMA_CONTROL_SOCKET` + `SIGMA_CONTROL_TOKEN` from env (instead of the jorvis socket env).
  - On startup, connect to the control socket and send `control.hello` `{ token, label: process.env.SIGMA_CONTROL_LABEL ?? 'external' }`; abort if the handshake errors.
  - `tools/list` → forward to the host `tools.list` (returns the external catalogue) and map to MCP tool descriptors.
  - `tools/call` → forward to host `tools.invoke` `{ name, args }` (origin is forced server-side; the bridge does NOT send origin).
- [ ] **Step 3:** Add the build entry so `electron-dist/mcp-sigma-control-server.cjs` is produced (mirror the jorvis entry in the build script).
- [ ] **Step 4: Test** — a node integration test: start a `ControlMcpHost` on a temp socket with a known token + a fake invoker, spawn the built `.cjs` with the env, speak MCP `initialize`+`tools/call` to its stdio, assert the fake invoker received the call with `origin:'external'`. (If the build step isn't wired in test, unit-test the request-mapping functions directly.)
- [ ] **Step 5: Commit** — `feat(control): external stdio MCP bridge (mcp-sigma-control-server)`

---

### Task 11: Settings surface (`claude mcp add` command + kill-switch)

**Files:** Modify the renderer Settings area — add a "External Control (MCP)" section: an enable toggle (`control.enable`/`control.disable`), a **Freeze** kill-switch (`control.freeze`/`control.unfreeze`), the copyable `claude mcp add …` command (`control.connectCommand`), token rotate, and a live `status()` (running + live connections). Add an escalation prompt UI driven by the `control:escalation` event → `control.respondEscalation`.

- [ ] **Step 1:** Build the component following the existing Settings pattern (find a sibling settings section, e.g. the Telegram/Browser settings, and mirror it). Wire the `control.*` RPC via the renderer rpc client.
- [ ] **Step 2:** Add the escalation toast/modal: subscribe to `control:escalation`, show `{ toolName, summary, label }`, Approve/Deny buttons → `control.respondEscalation(id, approved)`.
- [ ] **Step 3: Test** — a renderer component test (jsdom) that the toggle calls the RPC and the escalation modal renders + responds. (No live Electron.)
- [ ] **Step 4: Commit** — `feat(settings): External Control MCP panel (enable, freeze, connect command, escalation)`

---

## Phase 1 Exit Criteria / Final Gate

- [ ] Full `npx vitest run` green (esp. `tool-catalogue.test.ts`, `authorization.test.ts` UNCHANGED, `authz-external.test.ts`, `control-mcp-host.test.ts`, `prompt-sink.test.ts`, `rpc-channels.test.ts`, `terminal-cache.test.ts`).
- [ ] `npx tsc -b` clean (run in MAIN tree — it checks test files; worktree tsc is laxer).
- [ ] lint + `npm run build` succeed.
- [ ] Manual exit-criteria (operator, later): a fresh external Claude Code runs `claude mcp add sigmalink -- node …/mcp-sigma-control-server.cjs`, lists tools, reads a pane, launches a pane, gets a workspace opened; `close_pane` triggers an operator escalation; the Freeze kill-switch instantly denies all external calls.
- [ ] E2E deferred to CI (`tests/e2e/`) — do NOT run a live app locally.

---

## Extracted Interfaces (verbatim — read before coding)

> These are the exact existing signatures the tasks build against. Hand each Wave-1 subagent the relevant section.

**§1 Tool helper / ToolContext / close_pane** — `src/main/core/assistant/tools.ts`
- `T(id, name, description, inputSchema, schema, handler)` → `ToolDefinition` (tools.ts:163-177); handler is `async (a: z.infer<S>, ctx: ToolContext) => Promise<unknown>`.
- `ToolContext` (tools.ts:45-116): `pty`, `worktreePool`, `mailbox`, `memory`, `tasks`, `browserRegistry`, `defaultWorkspaceId: string|null`, `userDataDir`, `origin?: 'local'|'telegram'`, `confirmDangerous?`, `scanIngested?`, `kvGet?`, `cdpCallCounter?`, `notifications?`, `broadcastPtyError?`, `emit?: (event, payload) => void`. **No `workspaceId`/`conversationId`** — use `requireWs(ctx, explicit, label)` (tools.ts:127). **Add `promptSink?` in Task 6.**
- `close_pane` handler (tools.ts:396-422): `markPaneClosed(getRawDb(), a.sessionId, Date.now())` → `ctx.pty.kill(a.sessionId)` → `ctx.emit?.('assistant:pane-closed', { sessionId })`.

**§5 Catalogue + parity** — `tool-catalogue.ts` entries are `{ name, description, inputSchema: { type:'object', required?, properties } }`; parity test asserts `catalogueNames === toolIds`, required match, property keys match, and `systemPrompt.toContain(name)` (tool-catalogue.test.ts:34-71).

**§ Gate** — `src/main/core/assistant/controller.ts`: `export type ToolOrigin = 'local'|'telegram'` (:90); telegram gate `if (origin === 'telegram' && DANGEROUS_REMOTE.has(tool.id))` (:198-213); invoker returns `{ ok, result, error? }`; `invokeTool` public wrapper accepts `{ name, args, origin?, confirmDangerous? }` (:511).

**§ emit→dispatch** — `assistant:pane-closed` → `REMOVE_SESSION` in `use-live-events.ts:52-62` via `window.sigma.eventOn`. New session-scoped events need a subscriber here + a guard test.

**§8 protocol** — `src/main/core/swarms/protocol.ts` (node-safe): `parseProtocolLine(raw) → { verb, payload } | null`, `isPromptPayload(p)`, `ProtocolLineBuffer` (push/flush), `PROTOCOL_PREFIX='SIGMA::'`, `PROMPT` verb, `PromptPayload { question, type:'single'|'multi', choices[] }`. Registry `onData` (registry.ts:282-345) sees raw bytes; snapshot via `registry.snapshot(id): string`.

**§1/§3 host + quit** — `mcp-host-sigma.ts`: `net.createServer`, newline-delimited JSON-RPC, `start()/stop()`, forwards `tools.invoke` to `resolveInvoker()`. Owned in `buildRouter` (rpc-router.ts:749, started :2129). `shutdownRouter()` order (rpc-router.ts:2611-2764): capture pids → killAll → browser → memorySupervisor.stopAll → **mcpHostSigma.stop (:2670)** → ruflo → httpDaemon → telegram → … → waitForPidsExit → closeDatabase. Insert `controlMcpHost.stop()` after :2670.

**§6 KV / Credentials** — KV is an inline `{get,set}` over the `kv` table (rpc-router.ts:2290), flags compared `=== '1'`. `CredentialStore.{get,set,remove,isEncryptionAvailable}` (`core/credentials/storage.ts`). `KvLike`/`CredentialStoreLike` interfaces in `bridge.ts:68-78`.

**§8 RPC registration** — `defineController({...})` + add to `defineRouter({...})` (rpc-router.ts:2388) → auto-registered (:2480). **Add each renderer-facing `control.*` channel to `CHANNELS` in `src/shared/rpc-channels.ts`** (rpc-channels.test.ts enforces parity). The main-internal control socket does NOT need a CHANNELS entry.

**§ Process marker (Phase 2 Hermes)** — orphan markers must be a unique FILENAME in argv (CIM CommandLine), not an env var (`orphan-sweep.ts:30`). N/A for Phase 1 (the bridge is the client's child).
