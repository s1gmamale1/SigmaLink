// Gate for the OSC 0/2 title sink: plain-shell panes (providerId 'shell')
// must not forward terminal titles into the pane label — login shells with
// auto-title (oh-my-zsh precmd) emit OSC 0/2 at every prompt, which would
// clobber the clean-title invariant. Agent providers follow titles; the
// default (providerId unresolved) is FOLLOW, matching agent-first behavior.

const disabled = new Set<string>();

/** Enable/disable title-following for a session (view layer calls this when
 *  providerId resolves). Default (never called) is FOLLOW. */
export function setTitleFollow(sessionId: string, follow: boolean): void {
  if (follow) disabled.delete(sessionId);
  else disabled.add(sessionId);
}

/** Whether OSC titles should be forwarded to onAgentLabel for this session. */
export function shouldFollowTitle(sessionId: string): boolean {
  return !disabled.has(sessionId);
}

/** Test-only. */
export function __resetTitleFollow(): void {
  disabled.clear();
}
