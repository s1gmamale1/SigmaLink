// Safety layer for R-1 Jorvis Remote.
//
// All inbound Telegram messages pass through checkInbound() before the main
// process acts on them.  All outbound text passes through scrubOutbound()
// before it reaches the user.
//
// checkInbound() pipeline (in order):
//   1. Allowlist check    — not listed → deny (silent-drop + audit)
//   2. Locked check       — locked by operator → deny
//   3. Idle-lock check    — auto-lock if no activity for idleLockMs
//   4. Rate-limit         — token-bucket 5 req/min per chatId
//   5. Local heuristic    — injection / jailbreak pattern list
//   6. Ruflo aidefence    — opportunistic, skipped on any error
//
// scrubOutbound() pipeline:
//   1. Redact bot token literal
//   2. Redact common secret patterns (sk-…, ghp_…, AKIA…, Bearer …)
//   3. Redact email addresses and phone numbers (basic pass)
//   4. Opportunistic rufloCall('aidefence_has_pii', …)  — best-effort

import type { AuditEntry, AuditKind } from './audit.ts';
import { scrubPii } from '../security/pii-scrub';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SafetyLayer {
  checkInbound(
    chatId: number,
    text: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  scrubOutbound(text: string): Promise<string>;
  lock(): void;
  unlock(): void;
  isLocked(): boolean;
}

export interface SafetyLayerDeps {
  /** Returns the set of chatIds allowed to interact. Empty ⇒ deny ALL. */
  getAllowlist: () => number[];
  /** Injectable clock (ms since epoch). */
  now: () => number;
  /**
   * After this many milliseconds of inactivity the layer auto-locks.
   * 0 (or negative) disables the idle lock.
   */
  idleLockMs: number;
  /**
   * Returns the Telegram bot token so scrubOutbound can redact it.
   * Allowed to return null when the token is unavailable.
   */
  getToken: () => string | null;
  /** Called for every security-relevant event. */
  audit: (e: AuditEntry) => void;
  /**
   * Opportunistic call to Ruflo MCP security tools.
   * May be absent (feature not wired) or throw (MCP unavailable).
   * The safety layer NEVER throws or fails-open due to this.
   */
  rufloCall?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

// ─── Rate-limit constants ────────────────────────────────────────────────────

const RATE_LIMIT_MAX_TOKENS = 5;
const RATE_LIMIT_REFILL_MS = 60_000; // 1 minute

// Non-allowlisted senders are denied unconditionally, but their drop is only
// AUDITED once per chatId per this window — so an unauthenticated flood from an
// unknown sender (who is denied before the rate-limiter ever runs) can't
// amplify into unbounded O(file) audit writes / evict legitimate entries.
const DROP_AUDIT_THROTTLE_MS = 60_000;

// ─── Injection / jailbreak heuristic patterns ─────────────────────────────────
//
// This is a DOCUMENTED list of patterns. Any deviation from the spec's intent
// must be reviewed and updated here.

const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(previous|above)\s+instructions/i,
  /disregard\s+(previous|above|all)\s+instructions/i,
  /\bsystem\s+prompt\b/i,
  /\bexfiltrate\b/i,
  /\bprompt\s+injection\b/i,
  /\bjailbreak\b/i,
  /\bdan\s+mode\b/i,          // "DAN mode" jailbreak variant
  /\bact\s+as\s+if\s+you\s+(have\s+no|are\s+not|can|could)\b/i,
  /\byou\s+are\s+now\s+(a|an)\b/i, // "you are now a [different AI]"
  /pretend\s+(to\s+be|you\s+are)\b/i,
  /\bdev\s+mode\b/i,
  /\bsudo\s+(mode|override)\b/i,
];

// ─── Outbound scrub ───────────────────────────────────────────────────────────
// The secret / email / phone patterns now live in the shared
// `core/security/pii-scrub.ts` (H-19 — ONE audited regex set, consumed here AND
// by the assistant gate's scrubOutbound). The Telegram-specific bot-token
// redaction stays below (it is not general PII).

// ─── Token-bucket state ───────────────────────────────────────────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createSafetyLayer(deps: SafetyLayerDeps): SafetyLayer {
  const {
    getAllowlist,
    now,
    idleLockMs,
    getToken,
    audit,
    rufloCall,
  } = deps;

  let locked = false;
  let lastActivityMs = 0;

  // Per-chatId rate-limit buckets.
  const buckets = new Map<number, Bucket>();

  // Per-chatId timestamp of the last audited non-allowlisted drop (throttle).
  const dropAuditAt = new Map<number, number>();

  // ── Internal helpers ───────────────────────────────────────────────────────

  function auditEntry(
    kind: AuditKind,
    chatId: number | undefined,
    detail: string,
  ): void {
    audit({ ts: now(), kind, chatId, detail });
  }

  function consumeRateLimitToken(chatId: number): boolean {
    const t = now();
    let bucket = buckets.get(chatId);
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT_MAX_TOKENS, lastRefill: t };
      buckets.set(chatId, bucket);
    }
    // Refill proportionally to elapsed time.
    const elapsed = t - bucket.lastRefill;
    if (elapsed >= RATE_LIMIT_REFILL_MS) {
      bucket.tokens = RATE_LIMIT_MAX_TOKENS;
      bucket.lastRefill = t;
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  function matchesInjectionPattern(text: string): boolean {
    return INJECTION_PATTERNS.some((re) => re.test(text));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function checkInbound(
    chatId: number,
    text: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 1. Allowlist — denial is unconditional; the audit write is throttled
    //    per chatId so an unknown flooder can't amplify (the first drop for a
    //    given chatId is always recorded).
    const allowlist = getAllowlist();
    if (!allowlist.includes(chatId)) {
      const last = dropAuditAt.get(chatId);
      if (last === undefined || now() - last >= DROP_AUDIT_THROTTLE_MS) {
        dropAuditAt.set(chatId, now());
        auditEntry('drop', chatId, 'not-allowlisted');
      }
      return { ok: false, reason: 'not-allowlisted' };
    }

    // 2. Explicit lock
    if (locked) {
      return { ok: false, reason: 'locked' };
    }

    // 3. Idle-lock
    if (idleLockMs > 0 && lastActivityMs > 0) {
      const idle = now() - lastActivityMs;
      if (idle > idleLockMs) {
        locked = true;
        auditEntry('lock', chatId, `auto-locked after ${idle}ms idle`);
        return { ok: false, reason: 'locked' };
      }
    }

    // 4. Rate-limit
    if (!consumeRateLimitToken(chatId)) {
      return { ok: false, reason: 'rate-limited' };
    }

    // 5. Local injection / jailbreak heuristic (must run regardless of ruflo).
    if (matchesInjectionPattern(text)) {
      auditEntry('drop', chatId, 'flagged-input (local heuristic)');
      return { ok: false, reason: 'flagged-input' };
    }

    // 6. Opportunistic ruflo aidefence — NEVER throws, NEVER skips step 5.
    if (rufloCall) {
      try {
        const result = await rufloCall('aidefence_is_safe', { content: text });
        // Only act if ruflo returns an explicit false — be conservative.
        if (result && typeof result === 'object' && 'safe' in result) {
          const r = result as { safe: boolean; reason?: string };
          if (!r.safe) {
            auditEntry('drop', chatId, `flagged-input (aidefence: ${r.reason ?? 'unsafe'})`);
            return { ok: false, reason: 'flagged-input' };
          }
        }
      } catch {
        // Any failure → skip, local result stands (step 5 already passed).
      }
    }

    // Record activity for idle-lock.
    lastActivityMs = now();
    auditEntry('inbound', chatId, 'ok');
    return { ok: true };
  }

  async function scrubOutbound(text: string): Promise<string> {
    let out = text;

    // 1. Redact the bot token literal.
    const token = getToken();
    if (token) {
      // Escape special regex characters in the token.
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }

    // 2-3. Shared secret/email/phone scrub (core/security/pii-scrub.ts, H-19).
    out = scrubPii(out);

    // 4. Opportunistic ruflo PII check — best-effort, never throws.
    if (rufloCall) {
      try {
        const result = await rufloCall('aidefence_has_pii', { content: out });
        if (result && typeof result === 'object' && 'hasPii' in result) {
          const r = result as { hasPii: boolean; scrubbed?: string };
          if (r.hasPii && typeof r.scrubbed === 'string') {
            out = r.scrubbed;
          }
        }
      } catch {
        // Best-effort only — return whatever we have.
      }
    }

    return out;
  }

  function lock(): void {
    locked = true;
    auditEntry('lock', undefined, 'manual lock');
  }

  function unlock(): void {
    locked = false;
    lastActivityMs = now(); // Reset idle timer on unlock.
    auditEntry('unlock', undefined, 'manual unlock');
  }

  function isLocked(): boolean {
    return locked;
  }

  return { checkInbound, scrubOutbound, lock, unlock, isLocked };
}
