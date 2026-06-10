// FEAT-4 — interactive in-terminal prompt cards.
//
// This hook watches a pane's PTY stream for a structured clarifying-question
// line emitted by the agent:
//
//   SIGMA::PROMPT {"question":"…","type":"single"|"multi","choices":["a","b"]}
//
// When such a (valid) line arrives AND the feature is enabled, it exposes the
// active prompt so the caller can overlay a <PromptCard>. The operator's choice
// is written back to the pane's stdin via `rpc.pty.write(sessionId, answer + '\n')`.
//
// Re-buffering: `pty:data` chunks are coalesced on the main side (PERF-1) so a
// single SIGMA::PROMPT line can be split across chunks (or share a chunk with
// other output). 2026-06-10 finding 4: the bus has no replay, so a watcher that
// only lived while PaneShell was mounted lost prompt lines that arrived during a
// room/workspace switch. Parsing + prompt state now live in the module-scope
// `prompt-watcher` (installed on the first enabled mount and persisting across
// unmounts); this hook is a thin React adapter over it.
//
// OPT-IN: the hook is inert unless `enabled` is true. The caller gates that on
// the `pty.promptCards` KV flag (default OFF) to avoid false positives on
// untrusted PTY output.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { PromptPayload } from '@/main/core/swarms/protocol';
import {
  clearActivePrompt,
  ensurePromptWatcher,
  getActivePrompt,
  subscribeActivePrompt,
} from '@/renderer/lib/prompt-watcher';

export interface UsePromptCardResult {
  /** The active prompt, or null when none is pending. */
  prompt: PromptPayload | null;
  /**
   * Submit the operator's answer. `choices` are the chosen option text(s);
   * multi-select answers are joined by ", " and a trailing newline is appended
   * (the PTY write is raw — `rpc.pty.write` does NOT auto-newline). Clears the
   * active prompt.
   */
  answer: (choices: string[]) => void;
  /** Dismiss the active prompt without writing anything to stdin. */
  dismiss: () => void;
}

/**
 * FEAT-4 prompt-card hook. 2026-06-10 finding 4: parsing + prompt state live
 * in the module-scope prompt-watcher (installed on the first enabled mount and
 * persisting across unmounts, because the pty-data bus has no replay). This
 * hook is a thin React adapter: it ensures the watcher exists, mirrors the
 * module state via useSyncExternalStore, and writes answers back to stdin.
 */
export function usePromptCard(sessionId: string, enabled: boolean): UsePromptCardResult {
  // Keep a ref so the answer/dismiss callbacks have stable identity.
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // Install the persistent watcher on the first enabled mount. Deliberately
  // NOT torn down on unmount/disable — that persistence IS the fix; the GC
  // hook disposes it when the session leaves app state.
  useEffect(() => {
    if (!enabled) return;
    ensurePromptWatcher(sessionId);
  }, [sessionId, enabled]);

  const subscribe = useCallback(
    (cb: () => void) => subscribeActivePrompt(sessionId, cb),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getActivePrompt(sessionId), [sessionId]);
  const live = useSyncExternalStore(subscribe, getSnapshot);
  const prompt = enabled ? live : null;

  const answer = useCallback((choices: string[]) => {
    // C1 (review) — `choices` are AGENT-controlled (decoded from the SIGMA::PROMPT
    // JSON, so an escaped "\n" becomes a real newline). Strip control chars and
    // collapse newlines from each choice so a hostile choice like "yes\nrm -rf ~"
    // cannot inject a SECOND command line into the pane's stdin. The single
    // trailing '\n' we append below is the ONLY newline that reaches the CLI.
    const text = choices
      // eslint-disable-next-line no-control-regex -- stripping control chars IS the point (C1).
      .map((c) => c.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim())
      .filter((c) => c.length > 0)
      .join(', ');
    // Raw write — pty.write does not append a newline (see insertMention.ts /
    // insertSkillCommand.ts). The '\n' submits the (sanitized) answer to the CLI.
    void rpc.pty.write(sessionRef.current, `${text}\n`).catch(() => {
      /* registry swallows unknown-session writes; nothing to surface here */
    });
    clearActivePrompt(sessionRef.current);
  }, []);

  const dismiss = useCallback(() => {
    clearActivePrompt(sessionRef.current);
  }, []);

  return { prompt, answer, dismiss };
}
