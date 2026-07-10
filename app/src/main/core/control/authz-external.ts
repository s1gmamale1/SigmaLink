// src/main/core/control/authz-external.ts
//
// Supervised-autonomy authorization policy for origin:'external' tool calls.
// NOTE: classifyExternal is NOT fully side-effect-free — on the 'escalate'
// path it invokes the consumeGrant() callback (injected via deps) which mutates
// the one-shot grant store.  All other deps (targetProvider lookup, kill-switch
// read) remain I/O-free and safe under vitest.
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

/**
 * Tools explicitly denied for ALL external callers regardless of kill-switch state.
 * Intent: arbitrary file-write, raw shell/exec, or other tools with unbounded blast radius.
 * Currently empty — no such tools exist in JORVIS_TOOL_CATALOGUE. Extend here when
 * adding file-write/exec tools; they will be automatically excluded from getCatalogue()
 * served to external clients AND classified 'deny' by classifyExternal().
 */
export const EXTERNAL_DENY_TOOLS: ReadonlySet<string> = new Set<string>([
  // e.g. 'run_git_command', 'write_file' — add if such tools are added to the catalogue
]);

/**
 * Returns true when a tool should be included in the external tools.list response.
 * A tool is unlisted when it is in EXTERNAL_DENY_TOOLS — callers cannot discover
 * or invoke it via the external MCP surface.
 */
export function isExternallyListed(toolId: string): boolean {
  return !EXTERNAL_DENY_TOOLS.has(toolId);
}

/** Irreversible / high-blast-radius tools — always escalate to the operator. */
export const EXTERNAL_ESCALATE_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate',
  'close_pane',
  'close_workspace',
  'kill_swarm',
  'open_url',
  'stop_pane',
  // Phase 20 P1a — mission-board MUTATIONS. The board is operator-owned state
  // with no mediated external plane until P3; an external agent may attempt a
  // board change but the operator approves it. The read (`mission_board`) is
  // free (perception, like get_app_state). P3's mission plane will refine this.
  'create_mission',
  'add_mission_task',
  'move_mission_task',
  'complete_mission',
  // Phase 20 P1b — dispatch_task launches a real worktree-isolated pane
  // (process spawn + git worktree) AND mutates the operator-owned mission
  // board, same as its P1a mutation siblings above — escalate for external
  // origin.
  'dispatch_task',
  // P2 Task 3 — operator-private memory. Jorvis's durable cross-session
  // memory (facts/playbooks/preferences/postmortems) is the operator's own
  // long-term record, not a shared external-agent surface; conservative for
  // recall too (a read, but still operator-private) — all four escalate.
  'remember',
  'recall',
  'update_memory',
  'forget',
  // P2 Task 8 — propose_amendment writes a 'proposed' row that is inert
  // prompt-surface text until the operator decides it (jorvis.amendmentsDecide
  // RPC / AmendmentsPanel) — same conservative treatment as the memory tools:
  // a prompt-surface proposal, escalate for external origin even though the
  // proposal itself can never change behavior unapproved.
  'propose_amendment',
]);

/**
 * P3 Task 4 (D2) — `submit_task`/`check_task`/`get_report` are DELIBERATELY
 * ABSENT from this set. They are the external mission plane — the sanctioned
 * door an external Hermes/OpenClaw agent uses (ADR-011, two-plane design)
 * instead of the raw board tools above. `submit_task` is FREE for external
 * origin: safety lives downstream in the autonomy gates the decompose wake
 * it queues must clear (default-OFF `missions.autonomy.enabled` flag, daily
 * budget, quiet hours, kill-switch) and in the DANGEROUS_REMOTE escalation
 * layer any dispatch_task/prompt_agent call the resulting wake makes must
 * still clear — not at this door. `check_task`/`get_report` are free reads
 * (perception, like `mission_board`). The raw board-mutation tools directly
 * above (create_mission/add_mission_task/move_mission_task/complete_mission/
 * dispatch_task) KEEP their escalate classification for external origin —
 * this plane is the door, not the board.
 */

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
  // Hard-deny tools in the explicit deny list regardless of other conditions.
  if (EXTERNAL_DENY_TOOLS.has(input.toolId)) return 'deny';
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
