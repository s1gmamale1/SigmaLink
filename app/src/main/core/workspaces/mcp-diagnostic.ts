// P6 FEAT-5 — MCP config diagnostics controller.
//
// Foundation skeleton: real signature + empty result so rpc-router type-checks
// and wires the `mcp` namespace. The FEAT-5 lane implements the read+parse of
// each provider's on-disk MCP config (.mcp.json, .cursor/mcp.json, ~/.codex/
// config.toml, ~/.gemini/settings.json, ~/.kimi/mcp.json, opencode.json),
// flags scope conflicts / missing env / duplicate defs via the existing
// `isManagedRufloEntry` helpers in mcp-autowrite.ts, and raises an actionable
// notification per issue (ruflo-fallback-notice.ts pattern).
//
// Dependency-injected so it loads under vitest (rpc-router can't).

import type { getDb } from '../db/client';
import type { McpDiagnostic } from '../../../shared/types';

export type McpDiagDb = ReturnType<typeof getDb>;

/** Notification sink slice — same shape the workspace factory injects. */
export interface McpDiagnosticNotify {
  add: (input: {
    workspaceId: string | null;
    kind: string;
    severity: 'info' | 'warn' | 'error' | 'critical';
    title: string;
    body?: string;
    dedupKey: string;
  }) => void;
}

export interface McpDiagnosticDeps {
  getDb: () => McpDiagDb;
  /** Optional — when present, the diagnose pass raises a bell per flagged issue. */
  notify?: McpDiagnosticNotify;
}

export function buildMcpDiagnosticController(deps: McpDiagnosticDeps) {
  void deps;
  return {
    diagnoseWorkspace: async (input: { workspaceId: string }): Promise<McpDiagnostic> => {
      // FEAT-5 lane: resolve workspace root from getDb(), read each provider's
      // config, build servers[] + issues[], notify on warn/error, return.
      return {
        workspaceId: input.workspaceId,
        servers: [],
        issues: [],
        scannedAt: Date.now(),
      };
    },
  };
}
