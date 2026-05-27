// SF-7 — surface the silent stdio fallback.
//
// When the per-workspace Ruflo HTTP daemon can't spawn (binary missing, port
// collision after retries, etc.) `factory.ts` silently falls through to stdio
// MCP entries — previously only a `console.warn`. This helper raises a single
// in-app `info` notification per workspace so the operator knows Ruflo is
// running in the degraded stdio mode (no live daemon health, no HTTP features).
//
// Dedupe is in-process and per-workspaceId for the lifetime of the main
// process: a fallback fires the notice exactly once per workspace per app run,
// independent of the NotificationsManager's own 30s DB-level collapse window.
// Always fail-open — never throws into the caller (`openWorkspace`).

/** Minimal slice of `NotificationsManager.add` we depend on. The real
 *  `AddInput` requires `dedupKey` (the manager throws without it) and `kind`. */
export interface StdioFallbackNotificationInput {
  workspaceId: string | null;
  kind: string;
  severity: 'info' | 'warn' | 'error' | 'critical';
  title: string;
  body?: string | null;
  dedupKey: string;
}

export interface StdioFallbackNoticeDeps {
  notifications: { add: (input: StdioFallbackNotificationInput) => unknown };
}

const NOTIFICATION_KIND = 'ruflo.stdioFallback';
const NOTIFICATION_TITLE = 'Ruflo MCP — stdio fallback';
const NOTIFICATION_BODY =
  'The HTTP daemon is unavailable; running in stdio mode. Install @claude-flow/cli for full features.';

/** Workspaces already notified this process run. Module-level so the dedupe is
 *  shared across every `openWorkspace` call within a single main process. */
const notified = new Set<string>();

/**
 * Fire a one-time `info` notification when a workspace open fell back to stdio.
 *
 * @param deps          injectable notifications sink.
 * @param workspaceId   the opened workspace's id.
 * @param daemonSpawned `true` if the HTTP daemon spawned (a real port); `false`
 *                      if it fell back to stdio. Only the `false` case notifies.
 */
export function maybeNotifyStdioFallback(
  deps: StdioFallbackNoticeDeps,
  workspaceId: string,
  daemonSpawned: boolean,
): void {
  if (daemonSpawned) return;
  if (notified.has(workspaceId)) return;
  try {
    deps.notifications.add({
      workspaceId,
      kind: NOTIFICATION_KIND,
      severity: 'info',
      title: NOTIFICATION_TITLE,
      body: NOTIFICATION_BODY,
      // Stable per-workspace key so the manager also collapses any same-window
      // duplicates; our in-process Set is the authoritative once-per-run guard.
      dedupKey: `${NOTIFICATION_KIND}:${workspaceId}`,
    });
    // Only mark as notified AFTER a successful add — a throwing sink leaves the
    // workspace eligible for a later retry (fail-open without losing the notice).
    notified.add(workspaceId);
  } catch {
    /* fail-open — a notification failure must never break workspace open. */
  }
}

/** Test-only: clear the in-process dedupe set between cases. */
export function __resetStdioFallbackNoticeState(): void {
  notified.clear();
}
