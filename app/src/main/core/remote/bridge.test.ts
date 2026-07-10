// R-1 Lane B — TelegramBridge tests (node env).
//
// Mocks the stubbed client + safety factories + assistant seam. Covers:
//   • inert when disabled / no token / empty allowlist / no encryption
//   • happy path: onMessage → checkInbound(ok) → assistant.send(origin:'telegram')
//   • dangerous-tool confirmDangerous → sendConfirm; resolves true only on a
//     'confirm' callback, false on timeout
//   • /lock sets locked

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TelegramBridge,
  escapeHtml,
  chunkText,
  parseAllowlist,
  KV_TELEGRAM_OPERATOR_CHAT,
  KV_TELEGRAM_ALLOWLIST,
  type TelegramBridgeDeps,
  type AssistantSendInput,
  type MissionsBridgeDeps,
} from './bridge';
import type { TelegramClient, TelegramUpdateHandlers } from './telegram-client';
import type { SafetyLayer, SafetyLayerDeps } from './safety';
import type { AuditEntry } from './audit';
import type { Mission, MissionTask } from '../../../shared/types';

// ── test doubles ───────────────────────────────────────────────────────────────

interface FakeClient extends TelegramClient {
  _handlers: TelegramUpdateHandlers | null;
  _sent: Array<{ chatId: number; text: string }>;
  _confirms: Array<{ chatId: number; prompt: string; messageId: number }>;
  _started: boolean;
  _stopped: boolean;
}

function makeFakeClient(): FakeClient {
  let confirmSeq = 1000;
  const client: FakeClient = {
    _handlers: null,
    _sent: [],
    _confirms: [],
    _started: false,
    _stopped: false,
    async start(handlers) {
      this._handlers = handlers;
      this._started = true;
    },
    async stop() {
      this._stopped = true;
    },
    async sendMessage(chatId, text) {
      this._sent.push({ chatId, text });
      return this._sent.length;
    },
    async sendConfirm(chatId, prompt) {
      const messageId = ++confirmSeq;
      this._confirms.push({ chatId, prompt, messageId });
      return { messageId };
    },
  };
  return client;
}

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => void store.set(k, v),
  };
}

function makeCredentials(opts: { token?: string | null; encryption?: boolean } = {}) {
  let token = opts.token ?? null;
  const encryption = opts.encryption ?? true;
  return {
    get: vi.fn(async () => token),
    set: vi.fn(async (_k: string, v: string) => {
      token = v;
    }),
    remove: vi.fn(async () => {
      token = null;
      return true;
    }),
    isEncryptionAvailable: vi.fn(() => encryption),
  };
}

/** Build a bridge with fakes; returns the bridge + handles to the doubles. */
function makeBridge(over: Partial<TelegramBridgeDeps> = {}) {
  const client = makeFakeClient();
  const send = vi.fn(async (input: AssistantSendInput) => {
    void input;
    return { conversationId: 'c1', turnId: 't1' };
  });
  const newSession = vi.fn(async () => ({ ok: true as const }));
  // A simple deterministic safety layer factory honouring the allowlist + lock.
  let manualLock = false;
  const safetyFactory = (deps: SafetyLayerDeps): SafetyLayer => ({
    async checkInbound(chatId) {
      if (manualLock) return { ok: false, reason: 'locked' };
      return deps.getAllowlist().includes(chatId)
        ? { ok: true }
        : { ok: false, reason: 'not-allowlisted' };
    },
    async scrubOutbound(t) {
      return t;
    },
    lock() {
      manualLock = true;
    },
    unlock() {
      manualLock = false;
    },
    isLocked() {
      return manualLock;
    },
  });

  const kv = over.kv ?? makeKv({
    'remote.telegram.enabled': '1',
    'remote.telegram.allowlist': JSON.stringify([42]),
  });
  const credentials = over.credentials ?? makeCredentials({ token: 'tok', encryption: true });

  let stateSub: ((p: unknown) => void) | null = null;

  // In-memory audit log so unit tests never touch the filesystem.
  const auditEntries: AuditEntry[] = [];
  const auditFactory = (() => ({
    append: (e: AuditEntry) => void auditEntries.push(e),
    tail: (n: number) => auditEntries.slice(-n),
  })) as TelegramBridgeDeps['auditFactory'];

  const bridge = new TelegramBridge({
    kv,
    credentials,
    assistant: { send, newSession },
    subscribeAssistantState: (cb) => {
      stateSub = cb;
      return () => {
        stateSub = null;
      };
    },
    resolveDefaultWorkspaceId: () => 'ws-default',
    clientFactory: (() => client) as TelegramBridgeDeps['clientFactory'],
    safetyFactory,
    auditFactory,
    auditDir: '/tmp/sigmalink-test-audit',
    ...over,
  });

  return {
    bridge,
    client,
    send,
    newSession,
    emitState: (p: unknown) => stateSub?.(p),
    setLock: (v: boolean) => {
      manualLock = v;
    },
  };
}

// ── mission cockpit fixtures (P3 T2) ────────────────────────────────────────────

function mkMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Ship the widget',
    goal: 'ship the widget end to end',
    origin: 'telegram',
    clientLabel: null,
    workspaceId: 'ws1',
    status: 'active',
    report: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function mkTask(over: Partial<MissionTask> = {}): MissionTask {
  return {
    id: 't1',
    missionId: 'm1',
    title: 'Write the spec',
    spec: 'spec body',
    status: 'working',
    assigneeSessionId: null,
    worktreePath: null,
    attempt: 1,
    orderIdx: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

/** Fake `missions` closures — defaults are all "empty"/"not found"; override
 *  per test via `vi.fn` replacement. */
function makeMissionsDeps(over: Partial<MissionsBridgeDeps> = {}): MissionsBridgeDeps {
  return {
    createAndStart: vi.fn(() => 'mission-1'),
    enqueueDecompose: vi.fn(),
    autonomyEnabled: vi.fn(() => true),
    boardRead: vi.fn(() => []),
    listPanes: vi.fn(() => []),
    listWorkspaces: vi.fn(() => []),
    decideAmendment: vi.fn(() => 'not-found' as const),
    resolveEscalation: vi.fn(() => null),
    ...over,
  };
}

// ── helpers under test ──────────────────────────────────────────────────────────

describe('helpers', () => {
  it('escapeHtml escapes the 5 sensitive chars', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('chunkText splits at the cap and drops empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('ab', 4)).toEqual(['ab']);
    expect(chunkText('abcdef', 4)).toEqual(['abcd', 'ef']);
  });

  it('parseAllowlist tolerates junk and coerces strings', () => {
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist('not-json')).toEqual([]);
    expect(parseAllowlist('[1,"2",3.5,"x"]')).toEqual([1, 2]);
  });
});

// ── inert gates ───────────────────────────────────────────────────────────────

describe('TelegramBridge — inert gates', () => {
  it('stays inert when disabled', async () => {
    const kv = makeKv({ 'remote.telegram.allowlist': JSON.stringify([42]) }); // no enabled
    const { bridge, client } = makeBridge({ kv });
    expect(await bridge.start()).toBe('inert');
    expect(client._started).toBe(false);
    expect(bridge.isRunning()).toBe(false);
  });

  it('stays inert when no token', async () => {
    const { bridge, client } = makeBridge({
      credentials: makeCredentials({ token: null, encryption: true }),
    });
    expect(await bridge.start()).toBe('inert');
    expect(client._started).toBe(false);
  });

  it('stays inert when allowlist empty', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': '[]',
    });
    const { bridge, client } = makeBridge({ kv });
    expect(await bridge.start()).toBe('inert');
    expect(client._started).toBe(false);
  });

  it('stays inert when encryption unavailable (refuses plaintext)', async () => {
    const { bridge, client } = makeBridge({
      credentials: makeCredentials({ token: 'tok', encryption: false }),
    });
    expect(await bridge.start()).toBe('inert');
    expect(client._started).toBe(false);
  });
});

// ── happy path ──────────────────────────────────────────────────────────────────

describe('TelegramBridge — happy path', () => {
  it('runs when all gates pass and dispatches inbound with origin:telegram', async () => {
    const { bridge, client, send } = makeBridge();
    expect(await bridge.start()).toBe('running');
    expect(client._started).toBe(true);

    await client._handlers!.onMessage({ chatId: 42, text: 'hello jorvis' });

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.workspaceId).toBe('ws-default');
    expect(arg.prompt).toBe('hello jorvis');
    expect(arg.origin).toBe('telegram');
    expect(typeof arg.confirmDangerous).toBe('function');
  });

  it('drops non-allowlisted inbound silently (no reply, no dispatch)', async () => {
    const { bridge, client, send } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 999, text: 'hi' });
    expect(send).not.toHaveBeenCalled();
    expect(client._sent).toHaveLength(0);
    const tail = bridge.auditTail(10);
    expect(tail.some((e) => e.kind === 'inbound-dropped')).toBe(true);
  });

  it('resolves the workspace from voice.activeWorkspaceId when present', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
      'voice.activeWorkspaceId': 'ws-voice',
    });
    const { bridge, client, send } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'x' });
    expect(send.mock.calls[0][0].workspaceId).toBe('ws-voice');
  });
});

// ── commands ────────────────────────────────────────────────────────────────────

describe('TelegramBridge — commands', () => {
  it('/lock sets locked and does not dispatch', async () => {
    const { bridge, client, send } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/lock' });
    expect(bridge.isLocked()).toBe(true);
    expect(send).not.toHaveBeenCalled();
    // Subsequent inbound is dropped while locked.
    await client._handlers!.onMessage({ chatId: 42, text: 'still there?' });
    expect(send).not.toHaveBeenCalled();
  });

  it('/unlock clears the lock', async () => {
    const { bridge, client } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/lock' });
    expect(bridge.isLocked()).toBe(true);
    await client._handlers!.onMessage({ chatId: 42, text: '/unlock' });
    expect(bridge.isLocked()).toBe(false);
  });

  it('/new with no active conversation replies without calling newSession', async () => {
    const { bridge, client, newSession } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/new' });
    expect(newSession).not.toHaveBeenCalled();
    expect(client._sent).toHaveLength(1);
    expect(client._sent[0].text).toContain('No active Jorvis conversation yet');
  });

  it('/new clears the resume id on the last-dispatched conversation and confirms', async () => {
    const { bridge, client, send, newSession } = makeBridge();
    await bridge.start();
    // A prior prompt dispatches through assistant.send, which resolves
    // { conversationId: 'c1', turnId: 't1' } per the fake — the bridge tracks
    // that as the active conversation for /new.
    await client._handlers!.onMessage({ chatId: 42, text: 'hello jorvis' });
    expect(send).toHaveBeenCalledTimes(1);
    // Flush the fire-and-forget handleMessage continuation (the mock's own
    // async body + the post-await assignment of lastConversationId each need
    // a microtask tick) before the next inbound message races it.
    await Promise.resolve();
    await Promise.resolve();

    await client._handlers!.onMessage({ chatId: 42, text: '/new' });
    await Promise.resolve();
    await Promise.resolve();

    expect(newSession).toHaveBeenCalledTimes(1);
    expect(newSession).toHaveBeenCalledWith({ conversationId: 'c1' });
    const last = client._sent[client._sent.length - 1];
    expect(last.text).toContain('Fresh Jorvis session started');
  });

  it('/new is allowlist-gated like /lock', async () => {
    const { bridge, client, newSession } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 999, text: '/new' });
    expect(newSession).not.toHaveBeenCalled();
    expect(client._sent).toHaveLength(0);
  });
});

// ── dangerous-tool confirmation ──────────────────────────────────────────────────

describe('TelegramBridge — confirmDangerous', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a confirm and resolves true on a confirm callback', async () => {
    const { bridge, client, send } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'do it' });

    const confirmDangerous = send.mock.calls[0][0].confirmDangerous!;
    const p = confirmDangerous('rm_files', 'delete 3 files?');
    // sendConfirm fired.
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    expect(client._confirms).toHaveLength(1);
    const { messageId } = client._confirms[0];

    client._handlers!.onCallback({ chatId: 42, data: 'confirm', messageId });
    await expect(p).resolves.toBe(true);
  });

  it('resolves false on a cancel callback', async () => {
    const { bridge, client, send } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'do it' });
    const confirmDangerous = send.mock.calls[0][0].confirmDangerous!;
    const p = confirmDangerous('rm_files', 'delete?');
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    const { messageId } = client._confirms[0];
    client._handlers!.onCallback({ chatId: 42, data: 'cancel', messageId });
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on 60s timeout', async () => {
    const { bridge, client, send } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'do it' });
    const confirmDangerous = send.mock.calls[0][0].confirmDangerous!;
    const p = confirmDangerous('rm_files', 'delete?');
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    vi.advanceTimersByTime(60_001);
    await expect(p).resolves.toBe(false);
    const tail = bridge.auditTail(20);
    expect(tail.some((e) => e.kind === 'confirm-timeout')).toBe(true);
  });

  it('ignores a confirm callback from a non-matching chat (no cross-chat approval)', async () => {
    const { bridge, client, send } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'do it' });
    const confirmDangerous = send.mock.calls[0][0].confirmDangerous!;
    const p = confirmDangerous('rm_files', 'delete?');
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    const { messageId } = client._confirms[0];
    // A forged 'confirm' from a different chat must NOT approve the action.
    client._handlers!.onCallback({ chatId: 999, data: 'confirm', messageId });
    // The confirm stays pending and times out to false (proving 999 was ignored).
    vi.advanceTimersByTime(60_001);
    await expect(p).resolves.toBe(false);
  });
});

// ── confirmViaTelegram (P3 T5 / D4) ─────────────────────────────────────────────

describe('TelegramBridge — confirmViaTelegram', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns false and audits drop when the bridge is not running', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '42',
    });
    const { bridge, client } = makeBridge({ kv });
    // Never started — bridge stays 'inert'.
    const ok = await bridge.confirmViaTelegram('summary', 1000);
    expect(ok).toBe(false);
    expect(client._confirms).toHaveLength(0);
    const tail = bridge.auditTail(10);
    expect(tail.some((e) => e.kind === 'drop' && e.detail === 'confirm-bridge-stopped')).toBe(true);
  });

  it('returns false and audits drop when the operator chat id is unset', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge } = makeBridge({ kv });
    await bridge.start();
    const ok = await bridge.confirmViaTelegram('summary', 1000);
    expect(ok).toBe(false);
    const tail = bridge.auditTail(10);
    expect(tail.some((e) => e.kind === 'drop' && e.detail === 'confirm-no-operator-chat')).toBe(true);
  });

  it('returns false and audits drop when the captured chat was revoked from the allowlist', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '42',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    kv.set(KV_TELEGRAM_ALLOWLIST, JSON.stringify([]));
    const ok = await bridge.confirmViaTelegram('summary', 1000);
    expect(ok).toBe(false);
    expect(client._confirms).toHaveLength(0);
    const tail = bridge.auditTail(10);
    expect(
      tail.some((e) => e.kind === 'drop' && e.detail === 'confirm-chat-not-allowlisted' && e.chatId === 42),
    ).toBe(true);
  });

  it('sends to the OPERATOR chat (not activeChatId) and resolves true on an approve callback', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42, 77]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '77',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    // A different chat becomes "active" (mid-conversation) — every allowlisted
    // inbound message auto-recaptures the operator chat (D1), so re-pin it to
    // 77 explicitly afterward (e.g. an operator's earlier /subscribe) to
    // prove confirmViaTelegram targets the DURABLE operator chat, not
    // activeChatId, when the two have diverged.
    await client._handlers!.onMessage({ chatId: 42, text: 'hi' });
    kv.set(KV_TELEGRAM_OPERATOR_CHAT, '77');

    const p = bridge.confirmViaTelegram('deploy prod?', 5000);
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    expect(client._confirms).toHaveLength(1);
    expect(client._confirms[0].chatId).toBe(77);
    const { messageId } = client._confirms[0];

    client._handlers!.onCallback({ chatId: 77, data: 'confirm', messageId });
    await expect(p).resolves.toBe(true);
  });

  it('HTML-escapes the confirm summary (I1 — attacker-influenceable arg values render as text)', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([77]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '77',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();

    const p = bridge.confirmViaTelegram('prompt_agent(prompt="<b>APPROVED ✓ tap deny</b>")', 5000);
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    expect(client._confirms).toHaveLength(1);
    expect(client._confirms[0].prompt).not.toContain('<b>');
    expect(client._confirms[0].prompt).toContain('&lt;b&gt;');

    const { messageId } = client._confirms[0];
    client._handlers!.onCallback({ chatId: 77, data: 'cancel', messageId });
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on a deny callback', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([77]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '77',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    const p = bridge.confirmViaTelegram('deploy prod?', 5000);
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    const { messageId } = client._confirms[0];
    client._handlers!.onCallback({ chatId: 77, data: 'cancel', messageId });
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on timeout using the CALLER-supplied timeoutMs', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([77]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '77',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    const p = bridge.confirmViaTelegram('deploy prod?', 120_000);
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    // Shorter than the caller-supplied timeout — must still be pending.
    vi.advanceTimersByTime(60_001);
    expect(client._confirms).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    await expect(p).resolves.toBe(false);
    const tail = bridge.auditTail(20);
    expect(tail.some((e) => e.kind === 'confirm-timeout')).toBe(true);
  });

  it('two concurrent confirmViaTelegram calls never cross-resolve', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([77]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '77',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    const p1 = bridge.confirmViaTelegram('op A', 5000);
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    const p2 = bridge.confirmViaTelegram('op B', 5000);
    for (let t = 0; t < 8; t++) await Promise.resolve(); // flush the scrub→sendConfirm hops (I1)
    expect(client._confirms).toHaveLength(2);
    const [c1, c2] = client._confirms;
    expect(c1.messageId).not.toBe(c2.messageId);

    // Approve only the SECOND request's message.
    client._handlers!.onCallback({ chatId: 77, data: 'confirm', messageId: c2.messageId });
    await expect(p2).resolves.toBe(true);
    // The first is still pending — times out independently to false.
    vi.advanceTimersByTime(5001);
    await expect(p1).resolves.toBe(false);
  });
});

// ── outbound relay ────────────────────────────────────────────────────────────────

describe('TelegramBridge — relay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('relays only on final and HTML-escapes the text (deltas alone never flush)', async () => {
    const { bridge, client, emitState } = makeBridge();
    await bridge.start();
    // Establish the active chat.
    await client._handlers!.onMessage({ chatId: 42, text: 'ping' });

    emitState({ kind: 'delta', delta: 'a<b' });
    emitState({ kind: 'delta', delta: '>c' });
    // Deltas alone must NOT trigger a send — even after the old debounce window.
    vi.advanceTimersByTime(700);
    await Promise.resolve();
    await Promise.resolve();
    expect(client._sent.filter((m) => m.chatId === 42)).toHaveLength(0);

    // The `final` event flushes immediately with the authoritative full text.
    emitState({ kind: 'final', text: 'a<b>c' });
    await Promise.resolve();
    await Promise.resolve();
    const relayed = client._sent.find((m) => m.text.includes('a&lt;b&gt;c'));
    expect(relayed).toBeTruthy();
  });

  it('sends the reply ONCE when deltas are followed by a final with the same cumulative text (SF-1 regression)', async () => {
    const { bridge, client, emitState } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'hello jorvis' });

    // Simulate a streaming reply: individual token deltas ...
    emitState({ kind: 'delta', delta: 'Hello' });
    emitState({ kind: 'delta', delta: ', world' });
    emitState({ kind: 'delta', delta: '!' });
    // ... then the final carrying the identical full text.
    emitState({ kind: 'final', text: 'Hello, world!' });

    // Drain all microtasks / timer callbacks.
    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();

    // The assistant reply must be delivered EXACTLY ONCE, not twice.
    const replyMsgs = client._sent.filter((m) => m.chatId === 42 && m.text.includes('Hello'));
    expect(replyMsgs).toHaveLength(1);
    expect(replyMsgs[0].text).toBe('Hello, world!');
  });

  it('still relays an error-only turn (no final emitted)', async () => {
    const { bridge, client, emitState } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'ping' });

    emitState({ kind: 'error', message: 'something went wrong' });
    // Error path uses debounce — advance past it.
    vi.advanceTimersByTime(700);
    await Promise.resolve();
    await Promise.resolve();
    expect(client._sent.some((m) => m.text.includes('something went wrong'))).toBe(true);
  });

  it('caps the relay buffer so a huge reply cannot blow up the scrub', async () => {
    const { bridge, client, emitState } = makeBridge();
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'ping' });
    // An adversarial reply far larger than the cap, delivered via final.
    const huge = 'x'.repeat(100_000);
    emitState({ kind: 'final', text: huge });
    await Promise.resolve();
    await Promise.resolve();
    const total = client._sent.reduce((n, m) => n + m.text.length, 0);
    // Bounded to MAX_RELAY_CHARS (8192) + a short truncation marker, not 100k.
    expect(total).toBeLessThan(9000);
    // Every Telegram message still respects the 4096-char cap.
    expect(client._sent.every((m) => m.text.length <= 4096)).toBe(true);
  });
});

// ── stop ──────────────────────────────────────────────────────────────────────────

describe('TelegramBridge — stop', () => {
  it('stops the client and unsubscribes', async () => {
    const { bridge, client } = makeBridge();
    await bridge.start();
    await bridge.stop();
    expect(client._stopped).toBe(true);
    expect(bridge.isRunning()).toBe(false);
  });
});

// ── operator chat-id capture (P3 T1 / D1) ───────────────────────────────────────

describe('TelegramBridge — operator chat-id capture', () => {
  it('captures the sender chat id on any allowlisted inbound message (before command routing)', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBeUndefined();

    await client._handlers!.onMessage({ chatId: 42, text: 'hello jorvis' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('42');
  });

  it('captures on a control command too (e.g. /lock), not just prompts', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/lock' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('42');
  });

  it('does NOT capture from a non-allowlisted sender', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 999, text: 'hi' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBeUndefined();
  });

  it('last-writer-wins: a second allowlisted chat overwrites the captured id', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42, 43]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'hi' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('42');
    await client._handlers!.onMessage({ chatId: 43, text: 'hi' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('43');
  });
});

// ── pushToOperator (P3 T1 / D1) ─────────────────────────────────────────────────

describe('TelegramBridge — pushToOperator', () => {
  it('returns false and audits push-bridge-stopped when the bridge is not running', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '42',
    });
    const { bridge, client } = makeBridge({ kv });
    // Never started — bridge stays 'inert'.
    const ok = await bridge.pushToOperator('hello');
    expect(ok).toBe(false);
    expect(client._sent).toHaveLength(0);
    const tail = bridge.auditTail(10);
    expect(tail.some((e) => e.kind === 'drop' && e.detail === 'push-bridge-stopped')).toBe(true);
  });

  it('returns false and audits push-no-operator-chat when the chat id is unset', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge } = makeBridge({ kv });
    await bridge.start();
    // No inbound message ever received — operatorChatId stays unset.
    const ok = await bridge.pushToOperator('hello');
    expect(ok).toBe(false);
    const tail = bridge.auditTail(10);
    expect(tail.some((e) => e.kind === 'drop' && e.detail === 'push-no-operator-chat')).toBe(true);
  });

  it('returns false and audits push-chat-not-allowlisted when the captured chat is revoked', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'hi' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('42');

    // Operator revokes 42 from the allowlist without clearing the captured id.
    kv.set(KV_TELEGRAM_ALLOWLIST, JSON.stringify([]));

    const ok = await bridge.pushToOperator('hello');
    expect(ok).toBe(false);
    const tail = bridge.auditTail(10);
    expect(
      tail.some((e) => e.kind === 'drop' && e.detail === 'push-chat-not-allowlisted' && e.chatId === 42),
    ).toBe(true);
  });

  it('happy path: scrubs, escapes, chunks, sends, and audits kind push', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'hi' });

    const ok = await bridge.pushToOperator('mission done <ok>');
    expect(ok).toBe(true);
    const sent = client._sent.find((m) => m.text.includes('mission done'));
    expect(sent).toBeTruthy();
    // Same escapeHtml pipeline as flushRelay/reply.
    expect(sent!.text).toContain('&lt;ok&gt;');
    const tail = bridge.auditTail(10);
    expect(tail.some((e) => e.kind === 'push' && e.chatId === 42)).toBe(true);
  });

  it('chunks an over-long push across multiple sendMessage calls (same choke point as relay)', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: 'hi' });
    client._sent.length = 0; // clear the /hi dispatch noise (none expected, but be safe)

    const huge = 'x'.repeat(5000);
    const ok = await bridge.pushToOperator(huge);
    expect(ok).toBe(true);
    const pushed = client._sent.filter((m) => m.text.includes('x'));
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed.every((m) => m.text.length <= 4096)).toBe(true);
  });
});

// ── /subscribe /unsubscribe (P3 T1 / D1) ────────────────────────────────────────

describe('TelegramBridge — subscribe/unsubscribe', () => {
  it('/subscribe sets the operator chat id and confirms', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/subscribe' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('42');
    expect(client._sent).toHaveLength(1);
    expect(client._sent[0].text.toLowerCase()).toContain('subscri');
  });

  it('/unsubscribe clears the operator chat id and confirms', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
      [KV_TELEGRAM_OPERATOR_CHAT]: '42',
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/unsubscribe' });
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBe('');
    expect(client._sent).toHaveLength(1);
    expect(client._sent[0].text.toLowerCase()).toContain('unsubscri');
  });

  it('/subscribe and /unsubscribe are allowlist-gated like /lock', async () => {
    const kv = makeKv({
      'remote.telegram.enabled': '1',
      'remote.telegram.allowlist': JSON.stringify([42]),
    });
    const { bridge, client } = makeBridge({ kv });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 999, text: '/subscribe' });
    expect(client._sent).toHaveLength(0);
    expect(kv.store.get(KV_TELEGRAM_OPERATOR_CHAT)).toBeUndefined();
  });
});

// ── mission cockpit commands (P3 T2) ─────────────────────────────────────────────

describe('TelegramBridge — mission cockpit — /mission', () => {
  it('creates + enqueues + replies "decompose queued" when autonomy is enabled', async () => {
    const missions = makeMissionsDeps({ autonomyEnabled: vi.fn(() => true) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/mission ship the widget' });

    expect(missions.createAndStart).toHaveBeenCalledWith('ship the widget');
    expect(missions.enqueueDecompose).toHaveBeenCalledWith('mission-1');
    expect(client._sent[0].text).toBe('mission mission-1 created — decompose queued');
  });

  it('still creates + enqueues but replies "parked" when autonomy is disabled', async () => {
    const missions = makeMissionsDeps({ autonomyEnabled: vi.fn(() => false) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/mission ship the widget' });

    // Enqueue happens regardless — the scheduler's disabled gate drops the
    // wake itself; only the reply text is honest about the parked state.
    expect(missions.createAndStart).toHaveBeenCalledWith('ship the widget');
    expect(missions.enqueueDecompose).toHaveBeenCalledWith('mission-1');
    expect(client._sent[0].text).toBe('mission mission-1 created — parked (autonomy disabled)');
  });

  it('preserves the goal\'s original casing/punctuation', async () => {
    const missions = makeMissionsDeps();
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/mission Ship the Widget, v2!' });
    expect(missions.createAndStart).toHaveBeenCalledWith('Ship the Widget, v2!');
  });

  it('empty goal replies usage and does not create a mission', async () => {
    const missions = makeMissionsDeps();
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/mission' });

    expect(missions.createAndStart).not.toHaveBeenCalled();
    expect(missions.enqueueDecompose).not.toHaveBeenCalled();
    expect(client._sent[0].text).toContain('usage');
  });
});

describe('TelegramBridge — mission cockpit — /status', () => {
  it('replies the board-format summary from boardRead()', async () => {
    const board = [{ mission: mkMission({ id: 'm1', title: 'Alpha' }), tasks: [mkTask({ status: 'working' })] }];
    const missions = makeMissionsDeps({ boardRead: vi.fn(() => board) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/status' });

    expect(missions.boardRead).toHaveBeenCalledTimes(1);
    expect(client._sent[0].text).toContain('Alpha');
    expect(client._sent[0].text).toContain('working:1');
  });

  it('replies "no active missions" for an empty board', async () => {
    const missions = makeMissionsDeps({ boardRead: vi.fn(() => []) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/status' });
    expect(client._sent[0].text).toBe('no active missions');
  });
});

describe('TelegramBridge — mission cockpit — /tasks', () => {
  it('with no id groups every active mission\'s tasks', async () => {
    const board = [
      { mission: mkMission({ id: 'm1', title: 'Alpha' }), tasks: [mkTask({ title: 'Task A' })] },
    ];
    const missions = makeMissionsDeps({ boardRead: vi.fn(() => board) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/tasks' });

    expect(missions.boardRead).toHaveBeenCalledTimes(1);
    expect(client._sent[0].text).toContain('Alpha');
    expect(client._sent[0].text).toContain('Task A');
  });

  it('with a known id shows just that mission\'s tasks', async () => {
    const board = [
      { mission: mkMission({ id: 'm1', title: 'Alpha' }), tasks: [mkTask({ title: 'Task A', attempt: 2 })] },
      { mission: mkMission({ id: 'm2', title: 'Beta' }), tasks: [mkTask({ title: 'Task B' })] },
    ];
    const missions = makeMissionsDeps({ boardRead: vi.fn(() => board) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/tasks m2' });

    expect(client._sent[0].text).toContain('Beta');
    expect(client._sent[0].text).toContain('Task B');
    expect(client._sent[0].text).not.toContain('Task A');
  });
});

describe('TelegramBridge — mission cockpit — /approve /deny', () => {
  it('/approve <id> decided via amendment replies the approval', async () => {
    const missions = makeMissionsDeps({ decideAmendment: vi.fn(() => 'decided' as const) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/approve am-1' });

    expect(missions.decideAmendment).toHaveBeenCalledWith('am-1', true);
    expect(missions.resolveEscalation).not.toHaveBeenCalled();
    expect(client._sent[0].text).toContain('am-1');
    expect(client._sent[0].text).toContain('approved');
  });

  it('/deny <id> falls back to escalation resolve when the amendment is not-found', async () => {
    const missions = makeMissionsDeps({
      decideAmendment: vi.fn(() => 'not-found' as const),
      resolveEscalation: vi.fn(() => ({ summary: 'close_pane sess-9 (hermes-1)' })),
    });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/deny esc-1' });

    expect(missions.decideAmendment).toHaveBeenCalledWith('esc-1', false);
    expect(missions.resolveEscalation).toHaveBeenCalledWith('esc-1', false);
    expect(client._sent[0].text).toContain('esc-1');
    expect(client._sent[0].text).toContain('denied');
    // Review I3 — the reply echoes WHAT was decided, never a bare id-grant.
    expect(client._sent[0].text).toContain('close_pane sess-9 (hermes-1)');
  });

  it('replies "nothing pending" when both amendment and escalation are not-found', async () => {
    const missions = makeMissionsDeps();
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/approve unknown-id' });

    expect(client._sent[0].text).toBe('nothing pending with id unknown-id');
  });

  it('empty id replies usage and calls no closures', async () => {
    const missions = makeMissionsDeps();
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/approve' });

    expect(missions.decideAmendment).not.toHaveBeenCalled();
    expect(missions.resolveEscalation).not.toHaveBeenCalled();
    expect(client._sent[0].text).toContain('usage');
  });
});

describe('TelegramBridge — mission cockpit — /panes /workspaces', () => {
  it('/panes joins listPanes() lines', async () => {
    const missions = makeMissionsDeps({ listPanes: vi.fn(() => ['claude · ws1 · running', 'codex · ws2 · idle']) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/panes' });
    expect(client._sent[0].text).toBe('claude · ws1 · running\ncodex · ws2 · idle');
  });

  it('/panes replies "no live panes" when empty', async () => {
    const missions = makeMissionsDeps({ listPanes: vi.fn(() => []) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/panes' });
    expect(client._sent[0].text).toBe('no live panes');
  });

  it('/workspaces joins listWorkspaces() lines', async () => {
    const missions = makeMissionsDeps({ listWorkspaces: vi.fn(() => ['ws1', 'ws2']) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/workspaces' });
    expect(client._sent[0].text).toBe('ws1\nws2');
  });

  it('/workspaces replies "no workspaces" when empty', async () => {
    const missions = makeMissionsDeps({ listWorkspaces: vi.fn(() => []) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/workspaces' });
    expect(client._sent[0].text).toBe('no workspaces');
  });
});

describe('TelegramBridge — mission cockpit — missions undefined (fail-soft)', () => {
  const cases: Array<[string, string]> = [
    ['/mission', '/mission ship it'],
    ['/status', '/status'],
    ['/tasks', '/tasks'],
    ['/approve', '/approve id-1'],
    ['/deny', '/deny id-1'],
    ['/panes', '/panes'],
    ['/workspaces', '/workspaces'],
  ];

  for (const [label, text] of cases) {
    it(`${label} replies the not-wired message when missions deps are absent`, async () => {
      const { bridge, client } = makeBridge({ missions: undefined });
      await bridge.start();
      await client._handlers!.onMessage({ chatId: 42, text });
      expect(client._sent[0].text).toBe('mission commands are not wired on this build');
    });
  }
});

describe('TelegramBridge — mission cockpit — allowlist gate', () => {
  it('/mission from a non-allowlisted sender is dropped silently', async () => {
    const missions = makeMissionsDeps();
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 999, text: '/mission ship it' });

    expect(missions.createAndStart).not.toHaveBeenCalled();
    expect(client._sent).toHaveLength(0);
  });
});

describe('TelegramBridge — mission cockpit — reply cap', () => {
  it('/status stays within the Telegram single-chunk cap for a huge board', async () => {
    const board = Array.from({ length: 200 }, (_, i) => ({
      mission: mkMission({ id: `m${i}`, title: `Mission number ${i} with a long descriptive title` }),
      tasks: [mkTask({ status: 'working' }), mkTask({ status: 'done' })],
    }));
    const missions = makeMissionsDeps({ boardRead: vi.fn(() => board) });
    const { bridge, client } = makeBridge({ missions });
    await bridge.start();
    await client._handlers!.onMessage({ chatId: 42, text: '/status' });

    // Capped to 3500 chars pre-escape; escaping can only grow plain text
    // slightly (no HTML-sensitive chars here), well inside one 4096 chunk.
    expect(client._sent).toHaveLength(1);
    expect(client._sent[0].text.length).toBeLessThanOrEqual(3501);
  });
});
