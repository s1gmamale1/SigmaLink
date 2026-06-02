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
// other output). We feed every chunk through `ProtocolLineBuffer` — the SAME
// newline splitter the swarm watcher uses (factory-spawn.ts) — so only COMPLETE
// lines are parsed. We import it from the shared protocol module rather than
// re-implementing it: protocol.ts is a pure module (no node/electron deps) and
// the renderer already imports values from `@/main/core/*` (see canDo.ts /
// AppearanceTab.tsx), so there is no bundling hazard and no drift risk.
//
// OPT-IN: the hook is inert unless `enabled` is true. The caller gates that on
// the `pty.promptCards` KV flag (default OFF) to avoid false positives on
// untrusted PTY output.

import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import {
  ProtocolLineBuffer,
  isPromptPayload,
  parseProtocolLine,
  type PromptPayload,
} from '@/main/core/swarms/protocol';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';

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
 * FEAT-4 prompt-card hook. Subscribes to `sessionId`'s PTY stream (when
 * `enabled`), surfaces the first valid `SIGMA::PROMPT` line as `prompt`, and
 * writes the operator's choice back to stdin on `answer`.
 */
export function usePromptCard(sessionId: string, enabled: boolean): UsePromptCardResult {
  const [prompt, setPrompt] = useState<PromptPayload | null>(null);
  // Keep a ref so the answer/dismiss callbacks have stable identity and don't
  // re-create the subscription on every prompt change.
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    // When disabled we do not subscribe. Any prompt that was active before the
    // feature was turned off is cleared by the previous effect run's cleanup
    // (which calls setPrompt(null)) — so we deliberately avoid a synchronous
    // setState in the effect body here.
    if (!enabled) return;
    // A fresh buffer per (session, enabled) subscription — a new pane or a
    // re-enable starts from a clean partial-line accumulator.
    const buf = new ProtocolLineBuffer();
    const unsubscribe = subscribePtyData(sessionId, ({ data }) => {
      buf.push(data, (line) => {
        const parsed = parseProtocolLine(line);
        if (!parsed || parsed.verb !== 'PROMPT') return;
        if (!isPromptPayload(parsed.payload)) return;
        // Latest valid prompt wins. We intentionally do NOT queue: a pane asks
        // one question at a time, and a newer question supersedes a stale one.
        setPrompt(parsed.payload);
      });
    });
    return () => {
      unsubscribe();
      setPrompt(null);
    };
  }, [sessionId, enabled]);

  const answer = useCallback((choices: string[]) => {
    const text = choices.join(', ');
    // Raw write — pty.write does not append a newline (see insertMention.ts /
    // insertSkillCommand.ts). The '\n' submits the answer to the CLI.
    void rpc.pty.write(sessionRef.current, `${text}\n`).catch(() => {
      /* registry swallows unknown-session writes; nothing to surface here */
    });
    setPrompt(null);
  }, []);

  const dismiss = useCallback(() => {
    setPrompt(null);
  }, []);

  return { prompt, answer, dismiss };
}
