// src/main/core/control/authz-external.ts
//
// Supervised-autonomy authorization policy for origin:'external' tool calls.
// PURE function — no I/O, no DB, no electron import (must load under vitest).
// The gate in controller.ts resolves `targetProvider` (the provider of the
// session a prompt_agent/send_keys targets) and the kill-switch, then asks
// this function for the verdict.

export type ExternalVerdict = 'free' | 'escalate' | 'deny';

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
  'browser_navigate',
  'close_pane',
  'close_workspace',
  'kill_swarm',
]);

/** Tools whose danger depends on the TARGET pane's provider (agent vs shell). */
export const PROVIDER_GATED_TOOLS: ReadonlySet<string> = new Set([
  'prompt_agent',
  'send_keys',
]);

export interface ClassifyInput {
  /** Canonical (post-alias) tool id. */
  toolId: string;
  /** Provider of the target session for provider-gated tools; null if N/A or unknown. */
  targetProvider: string | null;
  /** When true (operator froze external control) every call is denied. */
  killSwitch: boolean;
  /**
   * Task 4 — one-shot grant check. Called once when the verdict would be
   * 'escalate'; returning true consumes the grant and downgrades the verdict
   * to 'free' for this single call. Absent or returning false → escalate
   * as normal.
   */
  consumeGrant?: () => boolean;
}

export function classifyExternal(input: ClassifyInput): ExternalVerdict {
  if (input.killSwitch) return 'deny';
  let verdict: ExternalVerdict;
  if (EXTERNAL_ESCALATE_TOOLS.has(input.toolId)) {
    verdict = 'escalate';
  } else if (PROVIDER_GATED_TOOLS.has(input.toolId)) {
    verdict =
      input.targetProvider !== null && AGENT_PROVIDERS.has(input.targetProvider)
        ? 'free'
        : 'escalate';
  } else {
    verdict = 'free';
  }
  // Task 4: a matching unconsumed grant downgrades 'escalate' → 'free' (once).
  if (verdict === 'escalate' && input.consumeGrant?.()) return 'free';
  return verdict;
}
