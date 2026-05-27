// H-19 (partial) — Ruflo aidefence gate for the assistant runtime.
//
// Today `aidefence_*` exists only as Ruflo MCP tools and is wired into the
// runtime NOWHERE, so untrusted input is never scanned and the app reports
// `Security: PENDING`. This module wires the existing engine into the assistant
// send path. It generalises the OPPORTUNISTIC, LOCAL-FIRST, NEVER-FAIL-OPEN
// pattern R-1 established in `core/remote/safety.ts`:
//
//   - LOCAL-FIRST: the engine is best-effort enrichment, not a hard dependency.
//   - OPPORTUNISTIC: every Ruflo call is wrapped in try/catch; absent/throw is fine.
//   - NEVER-FAIL-OPEN-INTO-ERROR: aidefence being down must NEVER break the
//     assistant or throw — a missing/failing scan returns the safe default
//     (not-flagged inbound, unchanged outbound), it does NOT escalate to an error.
//
// `scanInbound` is ADVISORY for local operator input: it LOGS/AUDITS flagged
// prompts so `Security: PENDING` becomes active and threats are recorded, but it
// is the CALLER's decision whether to act — we never hard-block the operator's
// own prompt here. (Hard-blocking untrusted REMOTE input remains the job of
// R-1's `core/remote/safety.ts`.)
//
// SCOPE: this module + the assistant controller send-path wiring. Per-tool
// ingestion scanning (read_files / open_url / browser scrape) is a documented
// H-19 follow-up and is NOT handled here.

import { scrubPii } from './pii-scrub';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Opportunistic call to Ruflo MCP security tools. May be absent (feature not
 * wired) or throw (MCP unavailable). The gate NEVER throws or fails-open due to
 * this — mirrors `SafetyLayerDeps.rufloCall` in `core/remote/safety.ts`.
 */
export type RufloCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface AidefenceGate {
  /**
   * ADVISORY inbound scan. Returns `{ flagged: true, reason }` when the engine
   * explicitly reports the content unsafe; `{ flagged: false }` otherwise
   * (including when `rufloCall` is absent or throws). Never throws.
   */
  scanInbound(text: string): Promise<{ flagged: boolean; reason?: string }>;
  /**
   * Best-effort outbound PII scrub. Returns the engine's scrubbed text when it
   * reports PII; returns the input unchanged when `rufloCall` is absent, throws,
   * or reports no PII. Never throws.
   */
  scrubOutbound(text: string): Promise<string>;
  /**
   * H-19 (full) — INGESTION scan. Scans untrusted text the assistant's tools
   * pull into the model's context (`read_files` file contents,
   * `search_memories` entries) for prompt-injection BEFORE it reaches the
   * model. On a flagged item the content is COARSE-REDACTED (the whole item is
   * replaced with a fixed placeholder) and ANNOTATED with a fixed literal
   * prefix that names the source `label`; `flagged:true` is returned and the
   * detection is audited. Opportunistic: when `rufloCall` is absent, throws, or
   * reports the item safe, returns the input unchanged with `flagged:false`.
   * NEVER throws — a scan failure must not break a tool handler.
   */
  scanIngested(
    text: string,
    label: string,
  ): Promise<{ text: string; flagged: boolean; reason?: string }>;
}

export interface AidefenceGateDeps {
  /**
   * Opportunistic Ruflo proxy. Injected by the lead from the rpc-router as
   * `(tool, args) => rufloProxy.call(tool, args)`. May be absent or throw.
   */
  rufloCall?: RufloCall;
  /**
   * Called for every security-relevant event (a flagged inbound scan). Wired to
   * the existing notification/console path. Best-effort — never throws.
   */
  audit?: (e: { kind: string; detail: string }) => void;
}

// ─── Implementation ────────────────────────────────────────────────────────────

/**
 * FIXED literal placeholder for redacted ingested content. A constant — never
 * derived from the (untrusted) scanned text — so a crafted payload can't smuggle
 * instructions through the redaction marker itself.
 */
const INGESTION_REDACTION = '[⚠ aidefence: redacted potential injected content]';

/**
 * Wrap a redacted body in a FIXED annotation that names the source `label`. The
 * prefix is a constant template; only the operator-supplied `label` (e.g. a file
 * path or memory id — NOT the untrusted file content) and the constant
 * placeholder body are interpolated, so the annotation can't carry attacker text.
 */
function annotateIngestion(label: string, body: string): string {
  return `⚠ aidefence flagged & redacted content in ${label}\n${body}`;
}

/**
 * Unwrap whatever `rufloCall` returns into a plain record we can inspect.
 *
 * VERIFIED (live daemon, PID 47289, 2026-05-27): the Ruflo MCP supervisor
 * returns the raw `tools/call` result — the MCP envelope
 * `{ content: [{ type:'text', text: '<json-string>' }] }`. We parse the inner
 * JSON. We ALSO accept an already-parsed object verbatim, so the gate keeps
 * working if a future unwrap layer hands us the parsed verdict directly (and so
 * unit-test mocks can use either shape). Returns `null` on anything we can't
 * confidently read — the caller then treats it as "not flagged" (safe default).
 */
function unwrapAidefence(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  // MCP envelope: pull the first text block and JSON-parse it.
  if (Array.isArray(obj.content)) {
    const first = obj.content.find(
      (b): b is { type?: string; text?: unknown } =>
        !!b && typeof b === 'object' && 'text' in b,
    );
    if (first && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text) as unknown;
        return parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  // Already-parsed verdict.
  return obj;
}

/**
 * True when an unwrapped aidefence verdict explicitly reports the content
 * unsafe. Conservative: only an explicit `safe === false` (or a `threats` array
 * with entries) counts; anything ambiguous is treated as safe (no false-positive
 * redaction of clean content).
 */
function isFlaggedVerdict(v: Record<string, unknown> | null): boolean {
  if (!v) return false;
  if (v.safe === false) return true;
  if (Array.isArray(v.threats) && v.threats.length > 0) return true;
  return false;
}

/** Best-effort reason string from an unwrapped verdict (never throws). */
function reasonOf(v: Record<string, unknown> | null): string {
  if (v && typeof v.reason === 'string' && v.reason) return v.reason;
  if (v && Array.isArray(v.threats) && v.threats.length > 0) {
    const t0 = v.threats[0] as { type?: unknown };
    if (t0 && typeof t0.type === 'string') return t0.type;
  }
  return 'unsafe';
}

export function createAidefenceGate(deps: AidefenceGateDeps): AidefenceGate {
  const { rufloCall, audit } = deps;

  function emitAudit(kind: string, detail: string): void {
    if (!audit) return;
    try {
      audit({ kind, detail });
    } catch {
      // Audit sink is best-effort — never let it break the scan.
    }
  }

  async function scanInbound(
    text: string,
  ): Promise<{ flagged: boolean; reason?: string }> {
    // No engine wired → nothing to scan. Never fail-open into an error.
    if (!rufloCall) return { flagged: false };

    try {
      // H-19 — unwrap the live MCP envelope ({content:[{text:'<json>'}]}) AND
      // accept an already-parsed verdict (unit-test mocks / future layers).
      // Without this, the live daemon's enveloped reply is a latent no-op.
      const verdict = unwrapAidefence(
        await rufloCall('aidefence_is_safe', { content: text }),
      );
      if (isFlaggedVerdict(verdict)) {
        const reason = reasonOf(verdict);
        // ADVISORY: record the threat; the CALLER decides what to do. We do
        // NOT hard-block the local operator's own prompt.
        emitAudit('aidefence-inbound-flagged', reason);
        return { flagged: true, reason };
      }
      return { flagged: false };
    } catch {
      // aidefence down → safe default. NEVER fail-open into an error.
      return { flagged: false };
    }
  }

  async function scrubOutbound(text: string): Promise<string> {
    // H-19 — the LOCAL redactor is PRIMARY: it works offline and the live
    // aidefence engine reports PII but returns no `scrubbed` text, so an
    // engine-only scrub never actually redacts. scrubPii is ReDoS-safe + pure.
    let out = scrubPii(text);
    if (!rufloCall) return out;
    try {
      // Opportunistic belt-and-suspenders: if the engine ever DOES return
      // scrubbed text, compose it back through the local scrub so we never
      // un-redact. Envelope-unwrapped; never throws.
      const verdict = unwrapAidefence(
        await rufloCall('aidefence_has_pii', { content: out }),
      );
      if (verdict && typeof verdict.scrubbed === 'string') {
        out = scrubPii(verdict.scrubbed);
      }
    } catch {
      // Best-effort only — return the locally-scrubbed text, never throw.
    }
    return out;
  }

  async function scanIngested(
    text: string,
    label: string,
  ): Promise<{ text: string; flagged: boolean; reason?: string }> {
    // No engine wired → nothing to scan. Pass through unchanged.
    if (!rufloCall) return { text, flagged: false };

    try {
      // Prefer `aidefence_scan` (richest verdict). VERIFIED (live daemon,
      // 2026-05-27): its `threats[]` carry NO offsets/spans — only
      // {type,severity,confidence,description} — so SPAN-redaction is
      // impossible. We therefore COARSE-redact (replace the whole flagged item
      // with the fixed placeholder) rather than splicing out spans. If the
      // engine ever starts returning offsets, add a span branch here; until
      // then coarse is the correct + only viable path.
      let verdict: Record<string, unknown> | null = null;
      try {
        verdict = unwrapAidefence(await rufloCall('aidefence_scan', { content: text }));
      } catch {
        verdict = null; // scan unavailable → fall back to the boolean verdict.
      }
      if (!isFlaggedVerdict(verdict)) {
        // scan said safe OR was unreadable → confirm with the cheaper boolean.
        // (When scan already gave a confident safe verdict this is belt-and-
        // suspenders; when scan was unavailable this IS the verdict.)
        if (verdict === null) {
          const safeVerdict = unwrapAidefence(
            await rufloCall('aidefence_is_safe', { content: text }),
          );
          if (!isFlaggedVerdict(safeVerdict)) return { text, flagged: false };
          verdict = safeVerdict;
        } else {
          return { text, flagged: false };
        }
      }
      // Flagged → coarse-redact + annotate with the fixed prefix + audit.
      const reason = reasonOf(verdict);
      emitAudit('aidefence-ingestion-flagged', `${label}: ${reason}`);
      return {
        text: annotateIngestion(label, INGESTION_REDACTION),
        flagged: true,
        reason,
      };
    } catch {
      // aidefence down / unexpected error → safe default. NEVER fail-open into
      // an error: a scan failure must not break the tool handler or drop the
      // ingested content.
      return { text, flagged: false };
    }
  }

  return { scanInbound, scrubOutbound, scanIngested };
}
