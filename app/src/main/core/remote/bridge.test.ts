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
  type TelegramBridgeDeps,
  type AssistantSendInput,
} from './bridge';
import type { TelegramClient, TelegramUpdateHandlers } from './telegram-client';
import type { SafetyLayer, SafetyLayerDeps } from './safety';
import type { AuditEntry } from './audit';

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
    await Promise.resolve();
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
    await Promise.resolve();
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
    await Promise.resolve();
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
    await Promise.resolve();
    const { messageId } = client._confirms[0];
    // A forged 'confirm' from a different chat must NOT approve the action.
    client._handlers!.onCallback({ chatId: 999, data: 'confirm', messageId });
    // The confirm stays pending and times out to false (proving 999 was ignored).
    vi.advanceTimersByTime(60_001);
    await expect(p).resolves.toBe(false);
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
