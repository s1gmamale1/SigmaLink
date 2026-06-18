// src/main/core/control/escalation.ts
//
// Routes a dangerous-action confirmation (from an origin:'external' tool call)
// to the operator and resolves true/false. Phase 1: prefer a Telegram confirm
// if the bridge is live (operator's phone — works "while away"); else surface a
// renderer prompt via `notify` and await `resolve(id, approved)` from a control
// RPC; timeout / no channel -> DENY (fail-closed). Channels injected (no
// electron/DB import) so it loads + tests under vitest.

export interface EscalationRequest {
  id: string;
  toolName: string;
  summary: string;
  clientLabel: string;
}

export interface ExternalEscalatorDeps {
  /** Surface a pending confirmation to the renderer (broadcast). */
  notify?: (req: EscalationRequest) => void;
  /** Delegate to the operator's phone if the Telegram bridge is live; return null when unavailable. */
  telegramConfirm?: (summary: string) => Promise<boolean> | null;
  /** Append-only audit sink. */
  audit?: (entry: { ts: number; kind: string; toolName: string; clientLabel: string }) => void;
  /** ms before an unanswered renderer prompt auto-denies (default 60000). */
  timeoutMs?: number;
  /** id generator (injectable for tests). */
  genId?: () => string;
  /** clock (injectable for tests). */
  now?: () => number;
}

interface Pending {
  resolve: (v: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExternalEscalator {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private readonly deps: ExternalEscalatorDeps;

  constructor(deps: ExternalEscalatorDeps = {}) {
    this.deps = deps;
  }

  /** The confirmDangerous callback the Control MCP Host passes per dangerous call. */
  confirm = async (toolName: string, summary: string, clientLabel: string): Promise<boolean> => {
    // 1) Prefer the operator's phone if the bridge is live.
    const tg = this.deps.telegramConfirm?.(summary);
    if (tg) {
      const ok = await tg.catch(() => false);
      this.deps.audit?.({ ts: this.clock(), kind: ok ? 'tg-approved' : 'tg-denied', toolName, clientLabel });
      return ok;
    }
    // 2) Else surface a renderer prompt and await resolve(); deny if no channel.
    if (!this.deps.notify) {
      this.deps.audit?.({ ts: this.clock(), kind: 'no-channel-deny', toolName, clientLabel });
      return false;
    }
    const id = this.deps.genId ? this.deps.genId() : `esc-${++this.seq}`;
    this.deps.notify({ id, toolName, summary, clientLabel });
    this.deps.audit?.({ ts: this.clock(), kind: 'pending', toolName, clientLabel });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.deps.audit?.({ ts: this.clock(), kind: 'timeout-deny', toolName, clientLabel });
        resolve(false);
      }, this.deps.timeoutMs ?? 60_000);
      this.pending.set(id, { resolve, timer });
    });
  };

  /** Called by the control RPC when the operator answers in the renderer. */
  resolve(id: string, approved: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(approved);
  }

  /** Deny + clear all pending (e.g. on freeze/stop). */
  cancelAll(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
