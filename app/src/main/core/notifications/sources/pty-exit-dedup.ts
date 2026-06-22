// RC1 — Pure one-shot guard, unit-testable without better-sqlite3.
export function shouldSuppressPaneExitNotification(
  cliExitedSessions: Set<string>,
  sessionId: string,
): boolean {
  if (cliExitedSessions.has(sessionId)) {
    cliExitedSessions.delete(sessionId);
    return true;
  }
  return false;
}
