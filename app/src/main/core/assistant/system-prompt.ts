// V3-W14-001 — Sigma Assistant system prompt builder.
//
// Injected into every Claude CLI call via `--append-system-prompt` so the CLI
// has the workspace context it needs to reach for the right Sigma tool. Kept
// terse to stay under 1500 tokens (PRODUCT_SPEC §3.10 budget; R-1.1.1-2).
//
// CRITICAL: do NOT leak secrets, file contents, or PII here. Only structural
// metadata (workspace name + root, file *names*, swarm names + missions). The
// Claude CLI runs locally with the user's PATH; it sees what they let it see.

const TOOL_BLURB = `\
Available Sigma tools (call by name with the listed args; the host injects the
result back as a tool_result):

  launch_pane         { workspaceRoot, provider, count?, initialPrompt? }
                      Spawn 1-8 agent panes in the active workspace.
  prompt_agent        { sessionId, prompt }
                      Type a prompt into an existing PTY session.
  read_files          { paths: string[1..32], maxBytes? }
                      Read up to 32 files from disk (UTF-8, capped per file).
  open_url            { url, workspaceId? }
                      Open a URL in the active browser tab.
  create_task         { title, description?, labels?, workspaceId? }
                      Create a backlog task in the workspace kanban.
  create_swarm        { mission, preset, name?, workspaceId? }
                      Spin up a swarm. preset ∈ squad|team|platoon|battalion|custom.
  create_memory       { name, body?, tags?, workspaceId? }
                      Add a markdown memory note to the workspace memory hub.
  search_memories     { query, limit?, workspaceId? }
                      Search the memory hub for matching notes.
  broadcast_to_swarm  { swarmId, body }
                      Send a broadcast message to every agent in a swarm.
  roll_call           { swarmId?, workspaceId? }
                      Send ROLLCALL to one swarm (or every swarm in workspace).
`;

const STYLE_RULES = `\
Style rules:
  • Be terse. One short paragraph or a tight bullet list.
  • Be actionable. Prefer "I'll launch a 3-pane swarm" over "I could…".
  • Never apologise. If a tool fails, surface the error and propose the next step.
  • Use the workspace's actual paths and swarm names — never invent identifiers.
  • If the user's intent is ambiguous, ask exactly one clarifying question.
`;

export interface SigmaSystemPromptContext {
  /** Human-readable workspace name (e.g. "SigmaLink"). */
  workspaceName: string;
  /** Absolute path of the workspace root. */
  workspaceRoot: string;
  /** Current room the user is viewing (e.g. "bridge", "command", "operator"). */
  currentRoom?: string;
  /** Recently-touched files relative to workspaceRoot — trimmed to ~20. */
  recentFiles?: string[];
  /** One-line summary per active swarm (id + name + mission). */
  openSwarms?: Array<{ id: string; name: string; mission: string; preset: string }>;
}

/**
 * Builds the system prompt appended to every Sigma Assistant turn. The
 * preamble + tool description + style rules are static (~600 tokens); the
 * dynamic context block is bounded so the total prompt stays under ~1500
 * tokens for low-latency turns even on a busy workspace.
 *
 * Token budget:
 *   preamble + tools + style ≈ 600
 *   recentFiles cap  20 paths * ~12 tokens ≈ 240
 *   openSwarms  cap  10 entries * ~25 tokens ≈ 250
 *   workspace meta ≈ 30
 *   ────────────────────────────────────────── total ≈ 1120
 */
export function buildSigmaSystemPrompt(ctx: SigmaSystemPromptContext): string {
  const recent = (ctx.recentFiles ?? []).slice(0, 20);
  const swarms = (ctx.openSwarms ?? []).slice(0, 10);
  const room = ctx.currentRoom ? ` (currently in the "${ctx.currentRoom}" room)` : '';

  const recentFilesBlock =
    recent.length === 0
      ? '  (none yet — the user has not opened any files this session)\n'
      : recent.map((p) => `  • ${p}`).join('\n') + '\n';

  const swarmsBlock =
    swarms.length === 0
      ? '  (no active swarms)\n'
      : swarms.map((s) => `  • ${s.name} [${s.preset}, id=${s.id}] — ${s.mission}`).join('\n') +
        '\n';

  return `\
You are Sigma Assistant, the in-app intelligence inside SigmaLink — a desktop
developer workspace forked from BridgeMind/BridgeSpace. You help the user
orchestrate CLI coding agents (Claude, Codex, Gemini, Cursor) across
isolated Git worktrees, manage swarms, edit memory notes, and coordinate
work across panes.

Workspace: ${ctx.workspaceName} (${ctx.workspaceRoot})${room}

Recent files:
${recentFilesBlock}
Active swarms:
${swarmsBlock}
${TOOL_BLURB}
${STYLE_RULES}`;
}

/** Rough token estimate (4 chars/token heuristic) for budget telemetry. */
export function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
