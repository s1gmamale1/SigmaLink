// R-1 Lane B — Jorvis Telegram remote bridge (supervisor).
//
// Owns the lifecycle of the Telegram long-poll client + the safety layer and
// shuttles messages between Telegram and the Sigma assistant. Modelled on
// `core/ruflo/http-daemon-supervisor.ts`: a small EventEmitter with a guarded
// start()/stop() and crash-notify path.
//
// SECURITY-CRITICAL. The bridge is INERT by default and only starts when ALL
// of the following hold:
//   • kv['remote.telegram.enabled'] === '1'
//   • a bot token exists in CredentialStore('remote.telegram.botToken')
//   • CredentialStore.isEncryptionAvailable() === true (refuse plaintext)
//   • the allowlist is non-empty
// Any failure leaves the bridge in 'inert' state and emits nothing.
//
// Inbound flow:
//   client.onMessage → safety.checkInbound
//     • !ok  → audit('inbound-dropped') + drop SILENTLY (no reply — never
//              confirm to an attacker that a chat id is/ isn't allowlisted)
//     • ok   → handle text commands (/lock /unlock /status) BEFORE dispatch,
//              else assistant.send({ origin:'telegram', confirmDangerous })
//
// Outbound flow:
//   assistant:state deltas → debounce(~700ms) → chunk(4096) → HTML-escape →
//   safety.scrubOutbound → client.sendMessage
//
// Dangerous-tool confirmation:
//   confirmDangerous(toolName, summary) → client.sendConfirm(chatId, summary),
//   register a pending entry resolved by an inline callback ('confirm'/'cancel');
//   60s timeout → resolve(false) + audit.
//
// P3 T5 — confirmViaTelegram(summary, timeoutMs) shares that exact machinery
// (see awaitConfirmReply) but always targets the durable OPERATOR chat
// (KV_TELEGRAM_OPERATOR_CHAT) instead of the current chat — the door for the
// external mission plane's ExternalEscalator and autonomous DANGEROUS_REMOTE
// wakes, both of which have no in-flight chat to reply into. No operator
// chat / bridge stopped / chat off the allowlist → immediate false.

import { EventEmitter } from 'node:events';
import { createTelegramClient, type TelegramClient } from './telegram-client';
import { createSafetyLayer, type SafetyLayer } from './safety';
import { createAuditLog, type AuditEntry, type AuditKind, type AuditLog } from './audit';
import { formatBoardSummary, formatTasks, type MissionBoardRow } from './board-format';

// ── constants ────────────────────────────────────────────────────────────────

/** kv keys. */
export const KV_TELEGRAM_ENABLED = 'remote.telegram.enabled';
export const KV_TELEGRAM_IDLE_LOCK_MIN = 'remote.telegram.idleLockMinutes';
export const KV_TELEGRAM_ALLOWLIST = 'remote.telegram.allowlist';
/** P3 D1 — durable operator chat id, auto-captured on every allowlisted
 *  inbound contact (last-writer-wins); the target of pushToOperator(). */
export const KV_TELEGRAM_OPERATOR_CHAT = 'remote.telegram.operatorChatId';
export const KV_VOICE_ACTIVE_WORKSPACE = 'voice.activeWorkspaceId';
/** CredentialStore key for the bot token. */
export const CRED_TELEGRAM_TOKEN = 'remote.telegram.botToken';

/** Debounce window for relaying streamed assistant deltas back to chat. */
const RELAY_DEBOUNCE_MS = 700;
/** Telegram hard message-length cap. */
const TELEGRAM_MAX_CHARS = 4096;
/** How long to wait for a confirm/cancel tap before defaulting to false. */
const CONFIRM_TIMEOUT_MS = 60_000;
/**
 * Hard cap on the accumulated relay buffer. flushRelay() runs the synchronous
 * outbound scrub over the WHOLE buffer before chunking (so a secret can't be
 * split across a chunk boundary and evade redaction); bounding the buffer keeps
 * that scrub from being handed an unbounded string by an adversarial reply
 * (event-loop DoS guard).
 */
const MAX_RELAY_CHARS = 8192;
/** Default idle-lock window when unset (minutes). */
const DEFAULT_IDLE_LOCK_MIN = 30;
/** P3 T2 — mission-cockpit command tokens, dispatched via runMissionCommand().
 *  Matched against the lowercased leading token (splitCommand's `cmd`), so
 *  each of these may carry a case-preserved argument tail. */
const MISSION_COMMANDS = new Set([
  '/mission',
  '/status',
  '/tasks',
  '/approve',
  '/deny',
  '/panes',
  '/workspaces',
]);
/** Fixed fail-soft reply for every mission command when `deps.missions` is unset. */
const MISSIONS_NOT_WIRED = 'mission commands are not wired on this build';

// ── public types ─────────────────────────────────────────────────────────────

export type BridgeStatus = 'inert' | 'running' | 'stopped' | 'error';

export interface CredentialStoreLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<boolean>;
  isEncryptionAvailable(): boolean;
}

export interface KvLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Assistant seam — matches the rpc-router:1527 cast contract. */
export interface AssistantSendInput {
  workspaceId: string;
  prompt: string;
  origin?: 'local' | 'telegram';
  confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
}
export interface AssistantSeam {
  send(input: AssistantSendInput): Promise<unknown>;
  /** P0.4 — fresh-session control for the `/new` command. Optional so older
   *  wiring/tests that don't supply it keep working (guarded call at use). */
  newSession?(input: { conversationId: string }): Promise<unknown>;
}

/** Minimal notifier — matches NotificationsManager.add. */
export interface BridgeNotifier {
  add(input: {
    workspaceId: string | null;
    kind: string;
    severity: 'info' | 'warn' | 'error' | 'critical';
    title: string;
    body?: string | null;
    dedupKey: string;
  }): unknown;
}

/**
 * P3 T2 — mission-cockpit closures injected from rpc-router. Optional so the
 * bridge stays usable (and every test above this section keeps working)
 * without a mission board wired up; when absent every mission command
 * replies a fixed fail-soft message instead of throwing. Keeps the bridge
 * DAO-decoupled: it never imports missionsDao directly.
 */
export interface MissionsBridgeDeps {
  /** Create a mission (title = first 60 chars of goal) + set it active. Returns the new mission id. */
  createAndStart(goal: string): string;
  /** Enqueue the mission's decompose wake. Called unconditionally — the
   *  autonomy-disabled gate is responsible for dropping the wake itself. */
  enqueueDecompose(missionId: string): void;
  /** Whether autonomous wakes currently run (the `/mission` reply text only — never gates the enqueue). */
  autonomyEnabled(): boolean;
  /** Full board snapshot (all missions + their tasks) for `/status` and `/tasks`. */
  boardRead(): MissionBoardRow[];
  /** One-line-per-pane summaries for `/panes`. */
  listPanes(): string[];
  /** One-line-per-workspace summaries for `/workspaces`. */
  listWorkspaces(): string[];
  /** Try to decide a pending amendment. 'not-found' when the id isn't a pending amendment. */
  decideAmendment(id: string, approved: boolean): 'decided' | 'not-found';
  /** Try to resolve a pending escalation. Null when the id isn't a pending
   *  escalation; on success returns the escalation's summary so the reply can
   *  echo WHAT was just approved (review I3 — informed consent, not a blind
   *  id-grant). */
  resolveEscalation(id: string, approved: boolean): { summary: string } | null;
}

export interface TelegramBridgeDeps {
  kv: KvLike;
  credentials: CredentialStoreLike;
  assistant: AssistantSeam;
  /** Subscribe to the router's `assistant:state` fan-out. Returns an unsub. */
  subscribeAssistantState: (cb: (payload: unknown) => void) => () => void;
  /** Resolve the default workspace id when kv hint is absent. */
  resolveDefaultWorkspaceId: () => string | null;
  /** Optional crash/error notifier (NotificationsManager). */
  notifier?: BridgeNotifier;
  /** Optional Ruflo MCP caller forwarded to the safety layer (aidefence). */
  rufloCall?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Directory for the append-only audit JSONL (created if absent). */
  auditDir: string;
  /** P3 T2 — optional mission-cockpit closures. Undefined → every mission
   *  command (`/mission /status /tasks /approve /deny /panes /workspaces`)
   *  fail-softs to a fixed "not wired" reply instead of throwing. */
  missions?: MissionsBridgeDeps;
  /** Test seams — default to the real factories + global fetch + Date.now. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  clientFactory?: typeof createTelegramClient;
  safetyFactory?: typeof createSafetyLayer;
  auditFactory?: typeof createAuditLog;
}

export interface BridgeStatusSnapshot {
  enabled: boolean;
  running: boolean;
  locked: boolean;
  allowlist: number[];
  encryptionAvailable: boolean;
  tokenSet: boolean;
}

// ── pending confirmation registry entry ───────────────────────────────────────

interface PendingConfirm {
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
  chatId: number;
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Escape the 5 HTML-sensitive chars Telegram's HTML parse mode rejects. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Split `text` into <=maxChars chunks (never splits a surrogate pair badly —
 *  slices by code unit which is safe for Telegram's UTF-16 length rule). */
export function chunkText(text: string, maxChars: number = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= maxChars) return text.length ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Split a raw inbound message into a lowercased command token + its
 * (case-preserved) argument tail — `/mission Ship it` → `{cmd:'/mission',
 * arg:'Ship it'}`. A bare command (no space) yields an empty arg.
 */
function splitCommand(raw: string): { cmd: string; arg: string } {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { cmd: trimmed.toLowerCase(), arg: '' };
  return { cmd: trimmed.slice(0, spaceIdx).toLowerCase(), arg: trimmed.slice(spaceIdx + 1).trim() };
}

/** Parse the persisted allowlist (JSON array of numbers). Tolerant of junk. */
export function parseAllowlist(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
}

// ── supervisor ───────────────────────────────────────────────────────────────

export class TelegramBridge extends EventEmitter {
  private status: BridgeStatus = 'inert';
  private client: TelegramClient | null = null;
  private safety: SafetyLayer | null = null;
  private readonly audit: AuditLog;
  private readonly deps: TelegramBridgeDeps;
  private readonly now: () => number;

  /** chatId of the most recent allowlisted sender — relay target. */
  private activeChatId: number | null = null;
  /** P0.4 — conversation id from the most recent assistant.send dispatch.
   *  `/new` targets this conversation (clears its resume id, keeps the
   *  transcript). Null until the first successful dispatch. */
  private lastConversationId: string | null = null;
  /** Accumulated delta text awaiting the debounced flush. */
  private relayBuffer = '';
  private relayTimer: NodeJS.Timeout | null = null;
  private unsubAssistantState: (() => void) | null = null;
  /** Outstanding dangerous-tool confirmations, keyed by sendConfirm messageId. */
  private readonly pending = new Map<number, PendingConfirm>();

  constructor(deps: TelegramBridgeDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.audit = (deps.auditFactory ?? createAuditLog)({ dir: deps.auditDir, now: this.now });
  }

  /** Tail the audit log (newest first). */
  auditTail(n: number): AuditEntry[] {
    return this.audit.tail(n);
  }

  /** Append an audit entry, stamping ts and normalizing the optional chatId. */
  private logAudit(kind: AuditKind, chatId: number | null | undefined, detail: string): void {
    this.audit.append({ ts: this.now(), kind, chatId: chatId ?? undefined, detail });
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  isLocked(): boolean {
    return this.safety?.isLocked() ?? false;
  }

  lock(): void {
    this.safety?.lock();
    this.logAudit('lock', this.activeChatId, 'manual lock');
  }

  unlock(): void {
    this.safety?.unlock();
    this.logAudit('unlock', this.activeChatId, 'manual unlock');
  }

  /** Snapshot for the controller's getStatus(). Never throws. */
  snapshot(token: string | null): BridgeStatusSnapshot {
    const enabled = this.deps.kv.get(KV_TELEGRAM_ENABLED) === '1';
    let encryptionAvailable = false;
    try {
      encryptionAvailable = this.deps.credentials.isEncryptionAvailable();
    } catch {
      encryptionAvailable = false;
    }
    return {
      enabled,
      running: this.isRunning(),
      locked: this.isLocked(),
      allowlist: parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST)),
      encryptionAvailable,
      tokenSet: typeof token === 'string' && token.length > 0,
    };
  }

  /**
   * Start the bridge IF the full precondition gate passes. Returns the
   * resulting status. Safe to call repeatedly (idempotent while running).
   */
  async start(): Promise<BridgeStatus> {
    if (this.status === 'running') return this.status;

    // Gate 1 — enabled flag.
    if (this.deps.kv.get(KV_TELEGRAM_ENABLED) !== '1') {
      this.status = 'inert';
      return this.status;
    }

    // Gate 2 — encryption available (refuse plaintext token at rest).
    let encryptionAvailable = false;
    try {
      encryptionAvailable = this.deps.credentials.isEncryptionAvailable();
    } catch {
      encryptionAvailable = false;
    }
    if (!encryptionAvailable) {
      this.status = 'inert';
      return this.status;
    }

    // Gate 3 — token present.
    let token: string | null = null;
    try {
      token = await this.deps.credentials.get(CRED_TELEGRAM_TOKEN);
    } catch {
      token = null;
    }
    if (!token) {
      this.status = 'inert';
      return this.status;
    }
    // Capture the token once for the lifetime of this running bridge. The
    // client/safety getters are synchronous (`() => string`); a token change
    // requires a stop()/start() cycle (the controller restarts on setToken).
    const botToken: string = token;

    // Gate 4 — non-empty allowlist.
    const allowlist = parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST));
    if (allowlist.length === 0) {
      this.status = 'inert';
      return this.status;
    }

    // All gates pass — instantiate the client + safety layer.
    const idleLockMin = Number(this.deps.kv.get(KV_TELEGRAM_IDLE_LOCK_MIN));
    const idleLockMs =
      (Number.isFinite(idleLockMin) && idleLockMin > 0 ? idleLockMin : DEFAULT_IDLE_LOCK_MIN) *
      60_000;

    const safetyFactory = this.deps.safetyFactory ?? createSafetyLayer;
    this.safety = safetyFactory({
      getAllowlist: () => parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST)),
      now: this.now,
      idleLockMs,
      getToken: () => botToken,
      audit: (e) => this.audit.append(e),
      rufloCall: this.deps.rufloCall,
    });

    const clientFactory = this.deps.clientFactory ?? createTelegramClient;
    this.client = clientFactory({
      fetch: this.deps.fetchImpl ?? fetch,
      getToken: () => botToken,
    });

    try {
      await this.client.start({
        onMessage: (msg) => void this.handleMessage(msg.chatId, msg.text),
        onCallback: (cb) => this.handleCallback(cb.messageId, cb.data, cb.chatId),
      });
    } catch (err) {
      this.status = 'error';
      this.notifyCrash(err);
      return this.status;
    }

    // Relay assistant deltas back to the active chat.
    this.unsubAssistantState = this.deps.subscribeAssistantState((payload) =>
      this.onAssistantState(payload),
    );

    this.status = 'running';
    this.logAudit('start', null, 'bridge started');
    this.emit('status', this.status);
    return this.status;
  }

  /** Stop the bridge. Safe to call when inert. */
  async stop(): Promise<void> {
    if (this.relayTimer) {
      clearTimeout(this.relayTimer);
      this.relayTimer = null;
    }
    this.relayBuffer = '';
    if (this.unsubAssistantState) {
      try {
        this.unsubAssistantState();
      } catch {
        /* ignore */
      }
      this.unsubAssistantState = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.safety = null;
    this.status = 'stopped';
    this.emit('status', this.status);
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  private async handleMessage(chatId: number, text: string): Promise<void> {
    if (!this.safety || !this.client) return;

    // P3 D1 — capture the durable operator chat id on EVERY allowlisted
    // contact (last-writer-wins), BEFORE command routing so it rides both
    // control commands and normal prompts alike. Non-allowlisted senders are
    // never captured (their drop is handled below by the existing gates —
    // this never confirms allowlist membership either way).
    const captureAllowlist = parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST));
    if (captureAllowlist.includes(chatId)) {
      this.deps.kv.set(KV_TELEGRAM_OPERATOR_CHAT, String(chatId));
    }

    const trimmedText = text.trim();
    const command = trimmedText.toLowerCase();
    // P3 T2 — mission-cockpit commands take a (case-preserved) argument tail;
    // `cmd` is the lowercased leading token, matched against MISSION_COMMANDS
    // below. `/status` moved from the plain bridge-health reply to the
    // mission-board summary (see MISSION_COMMANDS + runMissionCommand()).
    const { cmd, arg } = splitCommand(trimmedText);

    // Control commands (/lock /unlock /new /subscribe /unsubscribe) plus the
    // P3 T2 mission-cockpit commands are gated by ALLOWLIST ONLY — they must
    // bypass the lock gate so an allowlisted operator can /unlock after a
    // lock (a lock-gated /unlock could never get through). A non-allowlisted
    // sender is still dropped silently.
    if (
      command === '/lock' ||
      command === '/unlock' ||
      command === '/new' ||
      command === '/subscribe' ||
      command === '/unsubscribe' ||
      MISSION_COMMANDS.has(cmd)
    ) {
      const allowlist = parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST));
      if (!allowlist.includes(chatId)) {
        this.logAudit('inbound-dropped', chatId, 'dropped: not-allowlisted (command)');
        return;
      }
      this.activeChatId = chatId;
      if (command === '/lock') {
        this.lock();
        await this.reply(chatId, '🔒 Jorvis locked. Send /unlock to resume.');
      } else if (command === '/unlock') {
        this.unlock();
        await this.reply(chatId, '🔓 Jorvis unlocked.');
      } else if (command === '/new') {
        // P0.4 — fresh session: clear the resume id on the last-dispatched
        // conversation (transcript stays), so the next turn starts a clean
        // CLI context.
        if (!this.lastConversationId) {
          await this.reply(chatId, 'No active Jorvis conversation yet — send a prompt first.');
        } else {
          try {
            await this.deps.assistant.newSession?.({ conversationId: this.lastConversationId });
            await this.reply(chatId, '🆕 Fresh Jorvis session started (history kept).');
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logAudit('dispatch-error', chatId, message);
            await this.reply(chatId, `Sigma hit an error: ${message}`);
          }
        }
      } else if (command === '/subscribe') {
        // Explicit opt-in — redundant with the auto-capture above (this chat
        // is already allowlisted-and-captured) but kept deliberate/independent
        // so the intent is discoverable and doesn't rely solely on the
        // implicit last-writer-wins capture.
        this.deps.kv.set(KV_TELEGRAM_OPERATOR_CHAT, String(chatId));
        await this.reply(chatId, '📬 Subscribed — reports will land here.');
      } else if (command === '/unsubscribe') {
        this.deps.kv.set(KV_TELEGRAM_OPERATOR_CHAT, '');
        await this.reply(chatId, '🔕 Unsubscribed — no more reports here.');
      } else {
        // MISSION_COMMANDS.has(cmd) — the only other way into this block.
        await this.runMissionCommand(chatId, cmd, arg);
      }
      return;
    }

    // Everything else passes the FULL inbound gate (allowlist + lock + idle +
    // aidefence). On !ok: audit + drop SILENTLY (no reply — never confirm
    // allowlist membership to an attacker).
    const check = await this.safety.checkInbound(chatId, text);
    if (!check.ok) {
      this.logAudit('inbound-dropped', chatId, `dropped: ${check.reason ?? 'unknown'}`);
      return;
    }

    // This chat is the relay target for subsequent assistant deltas.
    this.activeChatId = chatId;

    const workspaceId = this.resolveWorkspaceId();
    if (!workspaceId) {
      this.logAudit('dispatch-skipped', chatId, 'no workspace');
      await this.reply(chatId, 'No active workspace — open one in SigmaLink first.');
      return;
    }

    this.logAudit('dispatch', chatId, 'assistant.send');
    try {
      const res = await this.deps.assistant.send({
        workspaceId,
        prompt: text,
        origin: 'telegram',
        confirmDangerous: (toolName, summary) => this.confirmDangerous(chatId, toolName, summary),
      });
      // P0.4 — track the conversation `/new` should target.
      const conversationId = (res as { conversationId?: unknown } | null)?.conversationId;
      if (typeof conversationId === 'string' && conversationId) {
        this.lastConversationId = conversationId;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logAudit('dispatch-error', chatId, message);
      await this.reply(chatId, `Sigma hit an error: ${message}`);
    }
  }

  // ── mission cockpit commands (P3 T2) ─────────────────────────────────────────

  /**
   * `/mission /status /tasks /approve /deny /panes /workspaces` — thin
   * dispatch over the injected `missions` closures. `deps.missions` unset →
   * fixed fail-soft reply for every one of these, never a throw. A closure
   * that itself throws is caught the same way `assistant.send` is above.
   */
  private async runMissionCommand(chatId: number, cmd: string, arg: string): Promise<void> {
    const missions = this.deps.missions;
    if (!missions) {
      await this.reply(chatId, MISSIONS_NOT_WIRED);
      return;
    }
    try {
      switch (cmd) {
        case '/mission': {
          if (!arg) {
            await this.reply(chatId, 'usage: /mission <goal>');
            return;
          }
          const id = missions.createAndStart(arg);
          // Enqueue regardless of the autonomy flag — the scheduler's
          // disabled gate drops the wake itself (with an audited reason);
          // this reply is just the honest reflection of that outcome.
          missions.enqueueDecompose(id);
          await this.reply(
            chatId,
            missions.autonomyEnabled()
              ? `mission ${id} created — decompose queued`
              : `mission ${id} created — parked (autonomy disabled)`,
          );
          return;
        }
        case '/status': {
          // /status was the bridge-health command before the P3 cockpit
          // repurposed it for the board — keep the one health fact a board
          // summary can't carry (any reply already proves the bridge is
          // alive): whether the assistant lane is locked.
          const lockPrefix = this.isLocked() ? '🔒 Jorvis is locked (/unlock to resume)\n\n' : '';
          await this.reply(chatId, lockPrefix + formatBoardSummary(missions.boardRead()));
          return;
        }
        case '/tasks': {
          await this.reply(chatId, formatTasks(missions.boardRead(), arg || undefined));
          return;
        }
        case '/approve':
        case '/deny': {
          const approved = cmd === '/approve';
          if (!arg) {
            await this.reply(chatId, `usage: ${cmd} <id>`);
            return;
          }
          if (missions.decideAmendment(arg, approved) === 'decided') {
            await this.reply(chatId, `amendment ${arg} ${approved ? 'approved' : 'denied'}`);
            return;
          }
          const resolved = missions.resolveEscalation(arg, approved);
          if (resolved) {
            await this.reply(
              chatId,
              `escalation ${arg} ${approved ? 'approved' : 'denied'}: ${resolved.summary.slice(0, 200)}`,
            );
            return;
          }
          await this.reply(chatId, `nothing pending with id ${arg}`);
          return;
        }
        case '/panes': {
          const panes = missions.listPanes();
          await this.reply(chatId, panes.length ? panes.join('\n') : 'no live panes');
          return;
        }
        case '/workspaces': {
          const workspaces = missions.listWorkspaces();
          await this.reply(chatId, workspaces.length ? workspaces.join('\n') : 'no workspaces');
          return;
        }
        default:
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logAudit('dispatch-error', chatId, message);
      await this.reply(chatId, `Sigma hit an error: ${message}`);
    }
  }

  // ── dangerous-tool confirmation ──────────────────────────────────────────────

  private async confirmDangerous(
    chatId: number,
    toolName: string,
    summary: string,
  ): Promise<boolean> {
    return this.awaitConfirmReply(chatId, summary, CONFIRM_TIMEOUT_MS, toolName);
  }

  /**
   * P3 T5 — shared pending-confirm machinery, extracted verbatim out of the
   * original `confirmDangerous` body (unchanged behaviour) so BOTH the
   * telegram-origin DANGEROUS_REMOTE gate (`confirmDangerous` above, mid-
   * conversation) and the phone-first escalation gate (`confirmViaTelegram`
   * below, external/autonomous) share ONE choke point: send the inline
   * approve/deny keyboard, register the resulting `sendConfirm` messageId in
   * `this.pending`, and resolve on the matching `handleCallback` or the
   * timeout. Telegram's own per-message id IS the concurrent-confirm
   * disambiguator (`this.pending` is keyed by it) — callback_data itself is
   * only ever the fixed 'confirm'/'cancel' string (see telegram-client.ts's
   * sendConfirm), but each confirm gets its own message, so two overlapping
   * confirms (same or different chat) can never cross-resolve.
   */
  private async awaitConfirmReply(
    chatId: number,
    summary: string,
    timeoutMs: number,
    auditDetail: string,
  ): Promise<boolean> {
    if (!this.client) return false;
    let messageId: number;
    try {
      // Review I1 — the confirm summary interpolates RAW tool-arg values (a
      // prompt-injected brain or an external client controls them) and
      // sendConfirm renders parse_mode:'HTML'. Scrub + escape like every
      // other outbound byte, or the one human-in-the-loop control can be
      // styled/obscured (or 400-bricked) by the very action it is gating.
      let scrubbed = summary;
      if (this.safety) {
        try {
          scrubbed = await this.safety.scrubOutbound(summary);
        } catch {
          scrubbed = summary;
        }
      }
      const sent = await this.client.sendConfirm(chatId, escapeHtml(scrubbed));
      messageId = sent.messageId;
    } catch (err) {
      this.logAudit('confirm-error', chatId, err instanceof Error ? err.message : String(err));
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        this.logAudit('confirm-timeout', chatId, auditDetail);
        resolve(false);
      }, timeoutMs);
      this.pending.set(messageId, { resolve, timer, chatId });
    });
  }

  /**
   * P3 T5 (D4) — phone-first escalation confirm for the external mission
   * plane (`ExternalEscalator`'s `telegramConfirm` dep) and autonomous
   * DANGEROUS_REMOTE wakes (`assistant.send`'s `confirmDangerous`, origin:
   * 'autonomous'). Unlike `confirmDangerous` above — which replies into the
   * CURRENT mid-conversation chat — this always targets the durable OPERATOR
   * chat (`KV_TELEGRAM_OPERATOR_CHAT`): an external client or an autonomous
   * wake has no in-flight chat to answer into. Fail-closed, never throws:
   * bridge not running, operator chat unset, or the captured chat fell off
   * the allowlist since capture → immediate false (audited `drop`), same
   * shape as `pushToOperator`. Resolves true ONLY on an approve callback
   * from that allowlisted chat within `timeoutMs`; reuses `awaitConfirmReply`
   * (see its doc comment for the concurrent-confirm disambiguation).
   */
  async confirmViaTelegram(summary: string, timeoutMs: number): Promise<boolean> {
    if (!this.isRunning() || !this.client) {
      this.logAudit('drop', null, 'confirm-bridge-stopped');
      return false;
    }

    const chatIdRaw = this.deps.kv.get(KV_TELEGRAM_OPERATOR_CHAT);
    if (!chatIdRaw) {
      this.logAudit('drop', null, 'confirm-no-operator-chat');
      return false;
    }
    const chatId = Number(chatIdRaw);

    const allowlist = parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST));
    if (!allowlist.includes(chatId)) {
      this.logAudit('drop', chatId, 'confirm-chat-not-allowlisted');
      return false;
    }

    return this.awaitConfirmReply(chatId, summary, timeoutMs, 'external-escalation');
  }

  private handleCallback(messageId: number, data: string, chatId: number): void {
    const entry = this.pending.get(messageId);
    if (!entry) return;
    // Defense-in-depth: the callback MUST originate from the same chat the
    // confirm was sent to, and that chat must still be allowlisted. A mismatch
    // is ignored WITHOUT resolving — the pending confirm stays open until its
    // own 60s timeout so a stray/forged callback can't approve (or deny)
    // another chat's dangerous action.
    const allowlist = parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST));
    if (chatId !== entry.chatId || !allowlist.includes(chatId)) {
      this.logAudit('confirm-error', chatId, `callback chat mismatch (msg ${messageId})`);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(messageId);
    const approved = data === 'confirm';
    this.logAudit(approved ? 'confirm-approved' : 'confirm-denied', entry.chatId, data);
    entry.resolve(approved);
  }

  // ── outbound relay ───────────────────────────────────────────────────────────

  private onAssistantState(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { kind?: string; delta?: string; text?: string; message?: string };
    if (p.kind === 'delta' && typeof p.delta === 'string') {
      // Accumulate deltas but do NOT flush yet — Telegram doesn't need token
      // streaming and flushing on every delta causes a double-send: the
      // debounced delta-flush already sends the full accumulated text, then
      // the subsequent `final` event re-sets the buffer to the same full text
      // and triggers a second flush (identical message sent twice). We wait
      // for `final` which carries the authoritative complete text.
      this.relayBuffer += p.delta;
      this.capRelayBuffer();
    } else if (p.kind === 'final' && typeof p.text === 'string') {
      // `final` is the single authoritative relay trigger. Cancel any pending
      // debounce (shouldn't exist, but guard against stale timers) and flush
      // immediately with the complete text.
      if (this.relayTimer) {
        clearTimeout(this.relayTimer);
        this.relayTimer = null;
      }
      this.relayBuffer = p.text;
      this.capRelayBuffer();
      void this.flushRelay();
    } else if (p.kind === 'error' && typeof p.message === 'string') {
      // Error-only turns may never emit `final` — relay via debounce so the
      // error message still reaches the operator.
      this.relayBuffer += `\n[error] ${p.message}`;
      this.capRelayBuffer();
      this.scheduleRelayFlush();
    } else {
      return;
    }
  }

  /** Bound the relay buffer (event-loop DoS guard — see MAX_RELAY_CHARS). */
  private capRelayBuffer(): void {
    if (this.relayBuffer.length > MAX_RELAY_CHARS) {
      this.relayBuffer = this.relayBuffer.slice(0, MAX_RELAY_CHARS) + '\n…[truncated]';
    }
  }

  private scheduleRelayFlush(): void {
    if (this.relayTimer) clearTimeout(this.relayTimer);
    this.relayTimer = setTimeout(() => {
      this.relayTimer = null;
      void this.flushRelay();
    }, RELAY_DEBOUNCE_MS);
  }

  private async flushRelay(): Promise<void> {
    const chatId = this.activeChatId;
    const buffered = this.relayBuffer;
    this.relayBuffer = '';
    if (!this.client || !this.safety || chatId === null || !buffered) return;
    await this.sendScrubbed(chatId, buffered, 'relay-error');
  }

  /** Plain operator reply (lock/unlock/status etc.). Scrubbed + escaped. */
  private async reply(chatId: number, text: string): Promise<void> {
    if (!this.client) return;
    await this.sendScrubbed(chatId, text, 'reply-error');
  }

  /**
   * Shared outbound choke point — every byte leaving the bridge (relay flush,
   * plain replies, and pushToOperator) goes through here: scrub → escapeHtml
   * → chunk(4096) → client.sendMessage per chunk, parseMode HTML. A send
   * failure on any chunk is audited under `errorKind` and stops the
   * remaining chunks (matches the prior flushRelay behavior).
   */
  private async sendScrubbed(
    chatId: number,
    text: string,
    errorKind: AuditKind = 'relay-error',
  ): Promise<void> {
    if (!this.client) return;
    let scrubbed = text;
    if (this.safety) {
      try {
        scrubbed = await this.safety.scrubOutbound(text);
      } catch {
        scrubbed = text;
      }
    }
    const safe = escapeHtml(scrubbed);
    for (const chunk of chunkText(safe)) {
      try {
        await this.client.sendMessage(chatId, chunk, { parseMode: 'HTML' });
      } catch (err) {
        this.logAudit(errorKind, chatId, err instanceof Error ? err.message : String(err));
        break;
      }
    }
  }

  /**
   * P3 D1 — proactive push to the durable operator chat. Kills the
   * incidental-`activeChatId` hole: a caller (rpc-router push hooks, the
   * daily-brief scheduler) can notify the operator's phone without an
   * in-flight conversation.
   *
   * Fail-soft by design (returns false, never throws): bridge not running →
   * audited drop; chat id unset/empty → audited drop; captured chat no
   * longer allowlisted (operator revoked it without clearing the capture) →
   * audited drop. Otherwise sends via the same scrub/escape/chunk pipeline
   * `flushRelay`/`reply` use and audits kind 'push'.
   */
  async pushToOperator(text: string): Promise<boolean> {
    if (!this.isRunning() || !this.client) {
      this.logAudit('drop', null, 'push-bridge-stopped');
      return false;
    }

    const chatIdRaw = this.deps.kv.get(KV_TELEGRAM_OPERATOR_CHAT);
    if (!chatIdRaw) {
      this.logAudit('drop', null, 'push-no-operator-chat');
      return false;
    }
    const chatId = Number(chatIdRaw);

    const allowlist = parseAllowlist(this.deps.kv.get(KV_TELEGRAM_ALLOWLIST));
    if (!allowlist.includes(chatId)) {
      this.logAudit('drop', chatId, 'push-chat-not-allowlisted');
      return false;
    }

    await this.sendScrubbed(chatId, text, 'relay-error');
    this.logAudit('push', chatId, 'pushed to operator');
    return true;
  }

  // ── workspace resolution (mirrors the voice path) ────────────────────────────

  private resolveWorkspaceId(): string | null {
    const fromKv = this.deps.kv.get(KV_VOICE_ACTIVE_WORKSPACE);
    if (fromKv) return fromKv;
    return this.deps.resolveDefaultWorkspaceId();
  }

  private notifyCrash(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logAudit('crash', null, message);
    try {
      this.deps.notifier?.add({
        workspaceId: null,
        kind: 'remote-telegram',
        severity: 'error',
        title: 'Jorvis Telegram remote failed to start',
        body: `The Telegram bridge could not start: ${message}. Check the bot token and your network connection in Settings → Telegram.`,
        dedupKey: 'remote-telegram-crash',
      });
    } catch {
      /* notifications are best-effort */
    }
    this.emit('status', this.status);
  }
}
