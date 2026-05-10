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
  hooks_intelligence_trajectory_start: 2_500,
  hooks_intelligence_trajectory_step: 2_500,
  hooks_intelligence_trajectory_end: 3_000,
};

export interface RufloTrajectoryStartInput {
  task: string;
  agent?: string;
}

export interface RufloTrajectoryStepInput {
  trajectoryId: string;
  action: string;
  result?: string;
  quality?: number;
}

export interface RufloTrajectoryEndInput {
  trajectoryId: string;
  success: boolean;
  feedback?: string;
}

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

  async trajectoryStart(input: RufloTrajectoryStartInput): Promise<string | null> {
    const raw = await this.callWithAlias<{ trajectoryId?: unknown }>(
      ['hooks_intelligence_trajectory_start', 'hooks_intelligence_trajectory-start'],
      input as unknown as Record<string, unknown>,
    );
    return typeof raw?.trajectoryId === 'string' ? raw.trajectoryId : null;
  }

  async trajectoryStep(input: RufloTrajectoryStepInput): Promise<void> {
    await this.callWithAlias(
      ['hooks_intelligence_trajectory_step', 'hooks_intelligence_trajectory-step'],
      input as unknown as Record<string, unknown>,
    );
  }

  async trajectoryEnd(input: RufloTrajectoryEndInput): Promise<void> {
    await this.callWithAlias(
      ['hooks_intelligence_trajectory_end', 'hooks_intelligence_trajectory-end'],
      input as unknown as Record<string, unknown>,
    );
  }

  private async callWithAlias<T = unknown>(
    toolNames: string[],
    args: Record<string, unknown>,
  ): Promise<T> {
    let lastErr: unknown;
    for (const toolName of toolNames) {
      try {
        return await this.call<T>(toolName, args);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
