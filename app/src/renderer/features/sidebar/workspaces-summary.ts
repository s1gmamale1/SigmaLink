// Workspace-status rollup helper. Extracted from WorkspacesPanel.tsx so the
// rule against non-component exports in a TSX file (react-refresh) is
// respected and the logic can be unit-tested without pulling React in.

import type { AgentSession } from '@/shared/types';

export type WorkspaceStatusKind = 'running' | 'error' | 'idle';

export interface WorkspaceStatus {
  /** Count of running sessions only — exited / starting / error are excluded. */
  running: number;
  /** Roll-up: `error` wins over `running` wins over `idle`. */
  kind: WorkspaceStatusKind;
}

/**
 * Bucket sessions by workspace and roll up the per-workspace status. The
 * panel renders one badge + one ring colour per workspace so we project
 * down to a single record per id rather than each session.
 */
export function summarizeWorkspaces(sessions: AgentSession[]): Map<string, WorkspaceStatus> {
  const map = new Map<string, WorkspaceStatus>();
  for (const s of sessions) {
    const prev = map.get(s.workspaceId) ?? { running: 0, kind: 'idle' as WorkspaceStatusKind };
    const running = prev.running + (s.status === 'running' ? 1 : 0);
    const kind: WorkspaceStatusKind =
      prev.kind === 'error' || s.status === 'error'
        ? 'error'
        : running > 0
          ? 'running'
          : 'idle';
    map.set(s.workspaceId, { running, kind });
  }
  return map;
}
