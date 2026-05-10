// Phase 4 Track C — Ruflo MCP proxy.
//
// Thin wrapper around `RufloMcpSupervisor.call()` that:
//   - resolves tool name aliases (the controller speaks renderer-friendly
//     dotted names; the upstream MCP server exports underscore-form tool ids)
//   - applies tool-specific timeout overrides
//   - normalises envelope rejection so the controller can branch on a single
//     `code === 'ruflo-unavailable'` shape.
//
// Public surface intentionally minimal: `proxy.call(toolName, args, opts?)`.

import type { RufloMcpSupervisor } from './supervisor';

/** Tool-specific timeout overrides (ms). Anything not listed falls back to
 *  the supervisor's default (5s). */
const TOOL_TIMEOUTS: Record<string, number> = {
  embeddings_search: 3_000,
  embeddings_generate: 4_000,
  'agentdb_pattern-search': 4_000,
  'agentdb_pattern-store': 8_000,
  autopilot_predict: 2_500,
};

export class RufloProxy {
  private readonly supervisor: RufloMcpSupervisor;

  constructor(supervisor: RufloMcpSupervisor) {
    this.supervisor = supervisor;
  }

  /** Forward a tool call to the supervisor. Errors include a stable
   *  `ruflo-unavailable:` prefix when the supervisor short-circuited (state
   *  not `ready`, rate limited, or stdin closed), so the controller can
   *  branch on the prefix rather than parsing free-form messages. */
  async call<T = unknown>(
    toolName: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUTS[toolName];
    return await this.supervisor.call<T>(toolName, args, { timeoutMs });
  }

  /** Convenience: returns true when the supervisor will accept a call. */
  isReady(): boolean {
    return this.supervisor.health().state === 'ready';
  }
}
