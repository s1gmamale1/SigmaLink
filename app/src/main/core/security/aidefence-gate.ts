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
      const result = await rufloCall('aidefence_is_safe', { content: text });
      // Only act on an explicit `safe:false` — be conservative.
      if (result && typeof result === 'object' && 'safe' in result) {
        const r = result as { safe: boolean; reason?: string };
        if (!r.safe) {
          const reason = r.reason ?? 'unsafe';
          // ADVISORY: record the threat; the CALLER decides what to do. We do
          // NOT hard-block the local operator's own prompt.
          emitAudit('aidefence-inbound-flagged', reason);
          return { flagged: true, reason };
        }
      }
      return { flagged: false };
    } catch {
      // aidefence down → safe default. NEVER fail-open into an error.
      return { flagged: false };
    }
  }

  async function scrubOutbound(text: string): Promise<string> {
    // No engine wired → return unchanged.
    if (!rufloCall) return text;

    try {
      const result = await rufloCall('aidefence_has_pii', { content: text });
      if (result && typeof result === 'object' && 'hasPii' in result) {
        const r = result as { hasPii: boolean; scrubbed?: string };
        if (r.hasPii && typeof r.scrubbed === 'string') {
          return r.scrubbed;
        }
      }
      return text;
    } catch {
      // Best-effort only — return whatever we have, never throw.
      return text;
    }
  }

  return { scanInbound, scrubOutbound };
}
