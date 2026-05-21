// v1.4.9 #07 — PTY exit notification source.
//
// Wiring contract (per brief §4): re-uses the existing `PtyRegistry.onPaneEvent`
// sink rather than adding a new `pty:exit` listener. The router's existing
// `onPaneEvent` handler now also calls `pushPtyExitNotification` so a single
// pane event lands in BOTH `jorvis_pane_events` (existing) AND
// `notifications` (this packet).
//
// Severity mapping (D1):
//   - `kind: 'exited'`, exit code 0 → `info`
//   - `kind: 'exited'`, exit code != 0 → `warn`
//   - `kind: 'error'` (signal-killed or registry-marked error) → `warn`
//   - `kind: 'started' | 'output-spike' | 'idle'` → IGNORED (not user-facing
//     events; they'd flood the bell).
//
// Dedup key (D3): `pty-exit:${sessionId}`. Per-session so two different
// panes exiting separately do NOT collapse; a single pane restart-looping
// (same sessionId) DOES collapse into one row.

import type { NotificationsManager } from '../manager';
import { getDb } from '../../db/client';
import { agentSessions } from '../../db/schema';
import { eq } from 'drizzle-orm';

export interface PtyExitEvent {
  sessionId: string;
  kind: 'started' | 'exited' | 'error' | 'output-spike' | 'idle';
  exitCode?: number;
  body?: string;
}

/** Resolve the workspace_id for a session id; nullable for rows that may
 *  have been forgotten already (the registry's graceful-forget delay). */
function resolveWorkspaceId(sessionId: string): string | null {
  try {
    const row = getDb()
      .select({ workspaceId: agentSessions.workspaceId })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return row?.workspaceId ?? null;
  } catch {
    return null;
  }
}

export function pushPtyExitNotification(
  manager: NotificationsManager,
  event: PtyExitEvent,
): void {
  // Skip non-exit events; the bell would otherwise drown in PTY chatter.
  if (event.kind !== 'exited' && event.kind !== 'error') return;

  // D1 mapping. `exited` with code 0 is the only `info` case; anything else
  // (non-zero code, signal-kill, error event) escalates to `warn`. error and
  // critical are reserved for sources that imply Sigma's agency or the app
  // itself is broken — pty-exit is "thing ended", not "thing crashed".
  const severity =
    event.kind === 'exited' && (event.exitCode ?? 0) === 0 ? 'info' : 'warn';

  const workspaceId = resolveWorkspaceId(event.sessionId);
  const codeStr = event.exitCode !== undefined ? `code ${event.exitCode}` : 'signal';

  manager.add({
    workspaceId,
    kind: 'pty-exit',
    severity,
    title: `Pane exited (${codeStr})`,
    body: event.body ?? null,
    payload: { sessionId: event.sessionId, exitCode: event.exitCode ?? null },
    sourceEvent: 'pty:exit',
    dedupKey: `pty-exit:${event.sessionId}`,
  });
}
