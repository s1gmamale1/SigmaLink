// Shared swarm-agent status derivation. Extracted from SwarmPhaseTree so it can
// be reused by the Sigma rail Canvas (BSP-O1) without tripping the
// `react-refresh/only-export-components` rule on the component file. Mirrors the
// color map in RoleRoster.tsx (~line 273–282).

import type { AgentSession, SwarmAgent } from '@/shared/types';

export type AgentStatus = SwarmAgent['status'];
export type SessionStatus = AgentSession['status'];

/** Combine swarm-agent status + PTY session status into a display status.
 *  Shared by the Swarm room (SwarmPhaseTree) and the Sigma rail Canvas so both
 *  show the SAME orchestration state rather than a session-only approximation. */
export function deriveStatus(
  agentStatus: AgentStatus,
  sessionStatus?: SessionStatus,
): { label: string; color: string; glyph: string } {
  // PTY error / exit takes precedence over agent-level status for display.
  if (sessionStatus === 'error') {
    return { label: 'error', color: '#ef4444', glyph: '✕' };
  }
  if (sessionStatus === 'exited') {
    return { label: 'exited', color: '#0ea5e9', glyph: '■' };
  }
  switch (agentStatus) {
    case 'error':
      return { label: 'error', color: '#ef4444', glyph: '✕' };
    case 'busy':
      return { label: 'busy', color: '#22c55e', glyph: '▶' };
    case 'blocked':
      return { label: 'blocked', color: '#f59e0b', glyph: '⏸' };
    case 'done':
      return { label: 'done', color: '#0ea5e9', glyph: '■' };
    default:
      return { label: 'idle', color: '#71717a', glyph: '○' };
  }
}
