// src/main/core/control/authz-external.ts
//
// Supervised-autonomy authorization policy for origin:'external' tool calls.
// PURE function — no I/O, no DB, no electron import (must load under vitest).
// The gate in controller.ts resolves `targetProvider` (the provider of the
// session a prompt_agent/send_keys targets) and the kill-switch, then asks
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
