// Renderer-only, ephemeral store for the operator's FIRST substantive typed
// line per pane. Used as a label fallback ranked below Claude's SIGMA::LABEL and
// the launch-prompt floor, but ABOVE the cute alias — so an interactive pane
// (opened blank, typed into) still shows what it's doing, bridgemind-style,
// before Claude emits its own label.
//
// There is no discrete composer: the operator types RAW into the terminal
// (DomTerminalView key events → pty.write). So we accumulate key events into a
// per-session draft and commit it on the SUBMITTING Enter (plain Enter; Shift/
// Alt+Enter insert a newline instead). This is approximate by design — cursor
// edits mid-line can desync the draft from the TUI's input box — but it is good
// enough for a label, and a real SIGMA::LABEL supersedes it the moment Claude
// emits one (see PaneHeader precedence). Mirrors the module-scope store pattern
// of pane-labels.ts.

import { sanitizeLabel } from '@/renderer/lib/pane-labels';

// Draft safety cap (pre-sanitize) so a pathological paste/hold can't grow the
// buffer unbounded; sanitizeLabel applies the final 80-char display cap.
const DRAFT_CAP = 400;
// Reject trivial commits (a stray Enter, a single char) — they aren't a task.
const MIN_COMMIT_LEN = 2;

/** The subset of a key event the capture reads (DOM-free, like input-encoder). */
export interface CaptureKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const drafts = new Map<string, string>();
const firstMessages = new Map<string, string>();
const captured = new Set<string>(); // first message locked in — stop accumulating
const subs = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = subs.get(sessionId);
  if (set) for (const cb of set) cb();
}

function appendDraft(sessionId: string, s: string): void {
  if (!s) return;
  const next = (drafts.get(sessionId) ?? '') + s;
  drafts.set(sessionId, next.length > DRAFT_CAP ? next.slice(0, DRAFT_CAP) : next);
}

function commit(sessionId: string): string | null {
  const raw = drafts.get(sessionId) ?? '';
  drafts.delete(sessionId);
  const clean = sanitizeLabel(raw);
  // Must be non-trivial AND contain a letter/digit (skip "...", whitespace-only,
  // lone punctuation, control noise that survived sanitize).
  if (!clean || clean.length < MIN_COMMIT_LEN || !/[a-z0-9]/i.test(clean)) return null;
  captured.add(sessionId);
  firstMessages.set(sessionId, clean);
  notify(sessionId);
  return clean;
}

/**
 * Feed one key event for a session. Returns the committed first-message line
 * when a submitting Enter finalizes a substantive draft (the value is also
 * stored + subscribers notified), otherwise null. A no-op once the session's
 * first message is captured.
 */
export function feedFirstMessageKey(sessionId: string, ev: CaptureKeyEvent): string | null {
  if (captured.has(sessionId)) return null;
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

/** Feed pasted text into the draft (newlines flattened to spaces). No-op once
 *  captured. A paste alone never commits — the operator still presses Enter. */
export function feedFirstMessagePaste(sessionId: string, text: string): void {
  if (captured.has(sessionId)) return;
  if (!text) return;
  appendDraft(sessionId, text.replace(/[\r\n]+/g, ' '));
}

/** Snapshot for useSyncExternalStore (stable string | null). */
export function getFirstMessage(sessionId: string): string | null {
  return firstMessages.get(sessionId) ?? null;
}

export function subscribeFirstMessage(sessionId: string, cb: () => void): () => void {
  let set = subs.get(sessionId);
  if (!set) { set = new Set(); subs.set(sessionId, set); }
  set.add(cb);
  return () => {
    const s = subs.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subs.delete(sessionId);
  };
}

/** Permanent removal (pane closed). Clears draft + message + the captured lock. */
export function clearFirstMessage(sessionId: string): void {
  drafts.delete(sessionId);
  captured.delete(sessionId);
  if (!firstMessages.has(sessionId)) return;
  firstMessages.delete(sessionId);
  notify(sessionId);
}

/** Test-only: wipe all state. */
export function __resetFirstMessages(): void {
  drafts.clear();
  firstMessages.clear();
  captured.clear();
}
