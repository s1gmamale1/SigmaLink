// Phase 4 Track C — Ruflo MCP embed.
// Shared type definitions for the supervisor + proxy + controller stack.
//
// State machine:
//   absent   — no install detected on disk
//   starting — child has been spawned, awaiting first JSON-RPC handshake
//   ready    — child is responsive, calls succeed
//   degraded — circuit breaker tripped (≥5 consecutive failures); calls
//              short-circuit until next successful probe
//   down     — exhausted restart budget; user must reset from Settings

export type RufloHealthState =
  | 'absent'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'down';

export interface RufloHealth {
  state: RufloHealthState;
  lastError?: string;
  pid?: number;
  uptimeMs?: number;
  /** Pinned Ruflo CLI semver discovered at install time (`<runtime>/version.json`). */
  version?: string;
  /** Absolute path to the install root (`<userData>/ruflo`). */
  runtimePath?: string;
}

/** Standard envelope for the Ruflo controller — the renderer treats `ok:false`
 *  with `code:'ruflo-unavailable'` as a clean degrade-to-empty rather than a
 *  hard failure. Any other code is surfaced via the global toast (the proxy
 *  rejects with a thrown Error so existing rpc helpers route the message). */
export interface RufloUnavailableResult {
  ok: false;
  code: 'ruflo-unavailable';
  reason: string;
}

export interface RufloInstallProgress {
  phase:
    | 'queued'
    | 'fetching-metadata'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'finalizing'
    | 'done'
    | 'error';
  bytesDone: number;
  bytesTotal: number;
  /** Set on `phase === 'error'`. */
  message?: string;
  /** Job correlation id; matches the `install.start()` return. */
  jobId: string;
}

/** The 6 RPC tool names this app forwards into the Ruflo MCP server. */
export type RufloToolName =
  | 'embeddings_search'
  | 'embeddings_generate'
  | 'agentdb_pattern-search'
  | 'agentdb_pattern-store'
  | 'autopilot_predict';
