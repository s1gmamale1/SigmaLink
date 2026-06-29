// src/main/core/control/pending-escalations.ts
//
// Pending-escalation map + one-shot grant store for non-blocking external
// escalations (Unit 4 of the control-plane interactive parity plan, Task 4).
//
// PURE — no electron/DB import; clock injected. Suitable for vitest.
//
// Flow:
//   1. External call hits 'escalate' verdict → registerEscalation() → id returned immediately.
//   2. Renderer broadcasts control:escalation (via optional notify callback).
//   3. Operator approves → resolveEscalation(id, true) → one-shot grant recorded.
//   4. Driver polls checkEscalation(id) → 'approved'.
//   5. Driver re-issues call → classifyExternal checks consumeGrant() → true → FREE → executes.

export interface PendingEscalation {
  id: string;
  toolName: string;
  summary: string;
  clientLabel: string;
  requestedAt: number;
}

export interface PendingEscalationsDeps {
  now?: () => number;
  genId?: () => string;
  /** TTL in ms for escalation entries and one-shot grants (default 120 000). */
  ttlMs?: number;
  /**
   * Optional broadcast hook — called after a new escalation is registered so
   * the renderer can show an approval dialog (mirrors the controlEscalator
   * notify path). Absent → silent registration only (unit tests / fallback).
   */
  notify?: (req: { id: string; toolName: string; summary: string; clientLabel: string }) => void;
}

interface EscalationRecord {
  entry: PendingEscalation;
  argsHash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: number;
}

interface GrantRecord {
  expiresAt: number;
  consumed: boolean;
}

function buildGrantKey(toolName: string, argsHash: string, clientLabel: string): string {
  return `${toolName}|${argsHash}|${clientLabel}`;
}

export class PendingEscalationStore {
  private readonly escalations = new Map<string, EscalationRecord>();
  private readonly grants = new Map<string, GrantRecord>();
  private seq = 0;
  private readonly deps: PendingEscalationsDeps;

  constructor(deps: PendingEscalationsDeps = {}) {
    this.deps = deps;
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private newId(): string {
    return this.deps.genId ? this.deps.genId() : `esc-${++this.seq}`;
  }

  private ttl(): number {
    return this.deps.ttlMs ?? 120_000;
  }

  registerEscalation(input: {
    toolName: string;
    argsHash: string;
    summary: string;
    clientLabel: string;
  }): { id: string } {
    const id = this.newId();
    const now = this.clock();
    const entry: PendingEscalation = {
      id,
      toolName: input.toolName,
      summary: input.summary,
      clientLabel: input.clientLabel,
      requestedAt: now,
    };
    this.escalations.set(id, {
      entry,
      argsHash: input.argsHash,
      status: 'pending',
      expiresAt: now + this.ttl(),
    });
    this.deps.notify?.({ id, toolName: input.toolName, summary: input.summary, clientLabel: input.clientLabel });
    return { id };
  }

  /**
   * Resolve a pending escalation. When approved, automatically records a
   * one-shot grant keyed by (toolName, argsHash, clientLabel) so the driver
   * can re-issue the original call and pass the external gate.
   */
  resolveEscalation(id: string, approved: boolean): void {
    const rec = this.escalations.get(id);
    if (!rec || rec.status !== 'pending') return;
    if (this.clock() > rec.expiresAt) {
      rec.status = 'expired';
      return;
    }
    rec.status = approved ? 'approved' : 'denied';
    if (approved) {
      const key = buildGrantKey(rec.entry.toolName, rec.argsHash, rec.entry.clientLabel);
      this.grants.set(key, { expiresAt: this.clock() + this.ttl(), consumed: false });
    }
  }

  checkEscalation(id: string): 'pending' | 'approved' | 'denied' | 'expired' {
    const rec = this.escalations.get(id);
    if (!rec) return 'expired';
    if (rec.status === 'pending' && this.clock() > rec.expiresAt) {
      rec.status = 'expired';
    }
    return rec.status;
  }

  /**
   * Consume a one-shot grant. Returns true ONCE for a matching, unconsumed,
   * non-expired grant; false on every subsequent call for the same key.
   */
  consumeGrant(toolName: string, argsHash: string, clientLabel: string): boolean {
    const key = buildGrantKey(toolName, argsHash, clientLabel);
    const grant = this.grants.get(key);
    if (!grant) return false;
    if (this.clock() > grant.expiresAt) {
      this.grants.delete(key);
      return false;
    }
    if (grant.consumed) return false;
    grant.consumed = true;
    return true;
  }

  /** Returns shallow copies of all currently pending escalations. */
  listPending(): PendingEscalation[] {
    const now = this.clock();
    const result: PendingEscalation[] = [];
    for (const [, rec] of this.escalations) {
      if (rec.status === 'pending' && now > rec.expiresAt) {
        rec.status = 'expired';
      }
      if (rec.status === 'pending') {
        result.push({ ...rec.entry });
      }
    }
    return result;
  }
}
