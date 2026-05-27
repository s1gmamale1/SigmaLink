// SF-7 — Task B1: per-workspace Ruflo HTTP daemon health hook.
//
// Polls `rpc.ruflo.daemonStatus(workspaceId)` every ~5 s (and once on mount)
// and maps the result to a normalised { state, detail } pair for the pane
// header health dot. Fail-safe: rejected RPC → 'unknown', never throws into
// the caller.
//
// State mapping:
//   row.status === 'running'             → 'running'
//   row.status === 'crashed' | 'down'    → 'down'
//   row.status === 'starting'            → 'starting'
//   no row for this workspaceId          → 'fallback' (stdio MCP is active)
//   RPC error / unavailable              → 'unknown'

import { useEffect, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';

export type RufloDaemonState = 'running' | 'fallback' | 'down' | 'starting' | 'unknown';

export interface RufloDaemonHealth {
  state: RufloDaemonState;
  detail: string;
}

const POLL_INTERVAL_MS = 5_000;

function mapRow(row: {
  status: string;
  port: number;
  connections: number | null;
}): RufloDaemonHealth {
  switch (row.status) {
    case 'running':
      return {
        state: 'running',
        detail: `running · port ${row.port}${row.connections != null ? ` · ${row.connections} conn` : ''}`,
      };
    case 'crashed':
      return { state: 'down', detail: 'crashed — restart the workspace to recover' };
    case 'down':
      return { state: 'down', detail: 'daemon down' };
    case 'starting':
      return { state: 'starting', detail: 'starting…' };
    default:
      return { state: 'unknown', detail: `unknown status: ${row.status}` };
  }
}

/**
 * Returns the live health of the Ruflo HTTP daemon for the given workspace.
 * Polls every 5 s; clears interval on unmount; never throws.
 */
export function useRufloDaemonHealth(workspaceId: string): RufloDaemonHealth {
  const [health, setHealth] = useState<RufloDaemonHealth>({
    state: 'unknown',
    detail: 'checking…',
  });

  useEffect(() => {
    let alive = true;

    async function poll(): Promise<void> {
      try {
        const rows = await rpcSilent.ruflo.daemonStatus(workspaceId);
        if (!alive) return;

        const row = rows.find((r) => r.workspaceId === workspaceId);
        if (!row) {
          setHealth({ state: 'fallback', detail: 'stdio fallback — HTTP daemon unavailable' });
          return;
        }
        setHealth(mapRow(row));
      } catch {
        if (!alive) return;
        setHealth({ state: 'unknown', detail: 'Ruflo MCP status unavailable' });
      }
    }

    void poll();
    const id = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [workspaceId]);

  return health;
}
