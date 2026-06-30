// Captures the operator's typed prompts per pane and feeds them into the shared
// pane-label store (pane-labels.ts), so the pane's LABEL re-titles on EVERY new
// prompt — and Claude's SIGMA::LABEL (same store, last-writer-wins) refines it
// once the agent starts the task. This is the pane LABEL, which is separate from
// the pane NAME/alias (PaneHeader renders them in distinct slots).
//
// There is no discrete composer: the operator types RAW into the terminal
// (DomTerminalView key events → pty.write). So we accumulate key events into a
// per-session draft and commit it on the SUBMITTING Enter (plain Enter; Shift/
// Alt+Enter insert a newline). Unlike a one-shot capture, there is NO lock — each
// submitted line overwrites, matching "re-title every prompt". Approximate by
// design (cursor edits mid-line can desync the draft); good enough for a label.

import { onPrompt } from '@/renderer/lib/pane-title-orchestrator';

// Draft safety cap (pre-sanitize) so a pathological paste/hold can't grow the
// buffer unbounded; sanitizeLabel applies the final 80-char display cap.
const DRAFT_CAP = 400;
// Reject trivial commits (a stray Enter, a single char) — they aren't a task.
const MIN_COMMIT_LEN = 2;

// Routine confirmations / acks must NOT re-title the pane: they'd blank the good
// title to "titling…" and (for non-self-labeling providers) spawn a needless
// Haiku call that sticks a junk "Yes"/"Approve" title. Skip a 1-2 word line made
// only of these, or a pure number/punctuation line.
const ACK_WORDS = new Set([
  'y', 'n', 'yes', 'no', 'ok', 'okay', 'k', 'yep', 'yeah', 'yup', 'nope', 'nah',
  'sure', 'go', 'stop', 'continue', 'cont', 'approve', 'approved', 'accept',
  'reject', 'deny', 'retry', 'again', 'done', 'next', 'skip', 'quit', 'exit',
  'q', 'c', 'cancel', 'back', 'good', 'great', 'thanks', 'ty', 'please', 'pls',
]);

function isLikelyAck(s: string): boolean {
  const t = s.toLowerCase().trim();
  if (/^[\d\s.,;:!?/\\()[\]{}'"`*_~+=-]+$/.test(t)) return true; // pure number/punct
  const words = t.split(/\s+/).filter(Boolean);
  return (
    words.length >= 1 &&
    words.length <= 2 &&
    words.every((w) => ACK_WORDS.has(w.replace(/[.!?,]+$/, '')))
  );
}

/** The subset of a key event the capture reads (DOM-free, like input-encoder). */
export interface CaptureKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const drafts = new Map<string, string>();

function appendDraft(sessionId: string, s: string): void {
  if (!s) return;
  const next = (drafts.get(sessionId) ?? '') + s;
  drafts.set(sessionId, next.length > DRAFT_CAP ? next.slice(0, DRAFT_CAP) : next);
}

function commit(sessionId: string): string | null {
  const raw = drafts.get(sessionId) ?? '';
  drafts.delete(sessionId);
  const clean = (raw.match(/[\p{L}\p{N}]/u) && raw.trim().length >= MIN_COMMIT_LEN)
    ? rawToLabel(raw)
    : null;
  if (!clean || isLikelyAck(clean)) return null;
  // Hand the prompt to the title orchestrator: it summarizes via the Ollama-cloud
  // model and sets the resulting title (the pane keeps its name until then). Re-
  // titles every prompt (routine acks are filtered above so they don't re-title).
  onPrompt(sessionId, clean);
  return clean;
}

// Collapse whitespace + trim (sanitizeLabel in setAgentLabel does the final
// ANSI/control strip + 80-cap; this keeps the alnum/length guard above honest).
function rawToLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Feed one key event for a session. Returns the committed prompt line when a
 * submitting Enter finalizes a substantive draft (the value is also pushed to
 * the shared label store), otherwise null.
 */
export function feedPromptKey(sessionId: string, ev: CaptureKeyEvent): string | null {
  if (ev.metaKey) return null; // host app shortcuts (copy/paste/zoom) — not input
  const { key } = ev;

  if (key === 'Enter') {
    // Shift/Alt+Enter insert a newline (multi-line compose); only a plain Enter
    // submits and finalizes the draft.
    if (ev.shiftKey || ev.altKey) {
      appendDraft(sessionId, '\n');
      return null;
    }
    return commit(sessionId);
  }
  if (key === 'Backspace') {
    const cur = drafts.get(sessionId);
    if (cur) drafts.set(sessionId, cur.slice(0, -1));
    return null;
  }
  // Printable characters only. Ctrl/Alt combos are control sequences, not text;
  // named keys (Arrow*, Tab, Escape, F1…, Home/End) have multi-char `key` and
  // are skipped (they may desync the draft, but degrade gracefully).
  if (key.length === 1 && !ev.ctrlKey && !ev.altKey) {
    appendDraft(sessionId, key);
  }
  return null;
}

/** Feed pasted text into the draft (newlines flattened to spaces). A paste alone
 *  never commits — the operator still presses Enter. */
export function feedPromptPaste(sessionId: string, text: string): void {
  if (!text) return;
  appendDraft(sessionId, text.replace(/[\r\n]+/g, ' '));
}

/** Drop a session's in-progress draft (pane closed). The committed LABEL lives in
 *  pane-labels and is cleared there by clearAgentLabel. */
export function clearPromptDraft(sessionId: string): void {
  drafts.delete(sessionId);
}

/** Test-only: wipe all drafts. */
export function __resetPromptCapture(): void {
  drafts.clear();
}
