// V3-W14-002 — Claude CLI streaming-JSON envelope shapes + parser helpers.
//
// Split out of `runClaudeCliTurn.ts` so each file stays under the 500-line
// project guideline. Pure data + a small parse helper; no I/O, no DB.
//
// Envelope reference (claude CLI v1+, captured live 2026-05-10):
//   {type: "system", subtype: "init"|"hook_*", ...}
//   {type: "assistant", message: {content: [{type: "text", text} | {type: "tool_use", id, name, input}]}}
//   {type: "user", message: {content: [{type: "tool_result", tool_use_id, content}]}}
//   {type: "result", subtype: "success", result, is_error: false, total_cost_usd, usage}
//   {type: "result", subtype: "error_during_execution"|"error_max_turns", is_error: true, ...}
//   {type: "rate_limit_event", ...}  (informational)

export interface CliSystemEnvelope {
  type: 'system';
  subtype?: string;
  [k: string]: unknown;
}

export interface CliAssistantContentBlock {
  type: 'text' | 'tool_use' | string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface CliAssistantEnvelope {
  type: 'assistant';
  message: {
    content: CliAssistantContentBlock[];
    [k: string]: unknown;
  };
}

export interface CliUserEnvelope {
  type: 'user';
  message: {
    content: Array<{ type: string; tool_use_id?: string; content?: unknown }>;
  };
}

export interface CliResultSuccessEnvelope {
  type: 'result';
  subtype: 'success';
  result: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
}

export interface CliResultErrorEnvelope {
  type: 'result';
  subtype: string; // 'error_during_execution', 'error_max_turns', etc.
  is_error: true;
  result?: string;
  total_cost_usd?: number;
}

export type CliResultEnvelope = CliResultSuccessEnvelope | CliResultErrorEnvelope;

export type CliEnvelope =
  | CliSystemEnvelope
  | CliAssistantEnvelope
  | CliUserEnvelope
  | CliResultEnvelope
  | { type: string; [k: string]: unknown };

/** Parse a single JSONL line into an envelope. Returns null on malformed
 *  input so the caller can surface the raw line as a fallback delta. */
export function parseCliLine(line: string): CliEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CliEnvelope;
  } catch {
    return null;
  }
}

export function isAssistantEnvelope(env: CliEnvelope): env is CliAssistantEnvelope {
  return env.type === 'assistant';
}

export function isResultEnvelope(env: CliEnvelope): env is CliResultEnvelope {
  return env.type === 'result';
}

export function isResultSuccess(env: CliResultEnvelope): env is CliResultSuccessEnvelope {
  return env.subtype === 'success' && env.is_error !== true;
}
