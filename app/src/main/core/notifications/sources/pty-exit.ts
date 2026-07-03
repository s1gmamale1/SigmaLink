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
//
// Bug 1 suppression: a deliberate close (closed_at set by markPaneClosed
// BEFORE the kill) is NOT an unexpected exit. The exit toast is suppressed.
// Keyed off closed_at (durable), not status (racy — 143/error overwrites it).

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

export interface SessionCloseMeta {
  workspaceId: string | null;
  closedAt: number | null;
}

/** Resolve workspace_id + closed_at for a session id; nullable when forgotten. */
function resolveSessionMeta(sessionId: string): SessionCloseMeta {
  try {
    const row = getDb()
      .select({ workspaceId: agentSessions.workspaceId, closedAt: agentSessions.closedAt })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return { workspaceId: row?.workspaceId ?? null, closedAt: row?.closedAt ?? null };
  } catch {
    return { workspaceId: null, closedAt: null };
  }
}

export function pushPtyExitNotification(
  manager: NotificationsManager,
  event: PtyExitEvent,
  resolveMeta: (sessionId: string) => SessionCloseMeta = resolveSessionMeta,
  isShuttingDown: () => boolean = () => false,
): void {
  // Skip non-exit events; the bell would otherwise drown in PTY chatter.
  if (event.kind !== 'exited' && event.kind !== 'error') return;

  // 2026-07-02 fix B — quit-time killAll() SIGTERMs every live pane while the
  // before-quit hold keeps the event loop (and DB) alive, so those exits used
  // to persist one "Pane exited (code 143)" WARN per pane (closed_at is NULL —
  // a quit is not a close) and greet the next boot as phantom crashes for
  // panes the resume-launcher restores alive. A shutdown is deliberate:
  // suppress. Fail OPEN — a broken gate must not silence real exits.
  try {
    if (isShuttingDown()) return;
  } catch {
    /* fail open */
  }

  const meta = resolveMeta(event.sessionId);
  // Bug 1 — a deliberate close (closed_at set) is NOT an unexpected exit.
  // Suppress the "Pane exited (code N)" toast for it. Covers the × button,
  // context-menu, and the close_pane tool (all set closed_at before the kill).
  if (meta.closedAt != null) return;

  // D1 mapping. `exited` with code 0 is the only `info` case; anything else
  // (non-zero code, signal-kill, error event) escalates to `warn`. error and
  // critical are reserved for sources that imply Sigma's agency or the app
  // itself is broken — pty-exit is "thing ended", not "thing crashed".
  const severity =
    event.kind === 'exited' && (event.exitCode ?? 0) === 0 ? 'info' : 'warn';

  const codeStr = event.exitCode !== undefined ? `code ${event.exitCode}` : 'signal';

  manager.add({
    workspaceId: meta.workspaceId,
    kind: 'pty-exit',
    severity,
    title: `Pane exited (${codeStr})`,
    body: event.body ?? null,
    payload: { sessionId: event.sessionId, exitCode: event.exitCode ?? null },
    sourceEvent: 'pty:exit',
    dedupKey: `pty-exit:${event.sessionId}`,
  });
}
