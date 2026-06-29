// Renderer-only, ephemeral pane auto-label store. Holds the latest SANITIZED
// label per sessionId, fed by label-reader.ts (Claude's SIGMA::LABEL line).
// PaneHeader reads it via useSyncExternalStore; precedence is
// `manual name → this label → summarizePrompt(initialPrompt) → alias`.
// Not persisted. Mirrors the module-scope store pattern of scratch-tabs.ts.

const LABEL_CAP = 80;
const PROMPT_CAP = 60;
// CSI sequences (colors, cursor) and raw control chars — stripped from labels.
// The \x1b / \x00-\x1f bytes are intentional terminal control characters.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/** Clean a label: strip ANSI + control chars, collapse whitespace, trim, cap.
 *  Returns null for junk (empty after cleaning). Callers treat null as
 *  "ignore — keep the last good value". */
export function sanitizeLabel(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(ANSI, '').replace(CONTROL, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > LABEL_CAP ? s.slice(0, LABEL_CAP) : s;
}

/** Floor label derived from the launch prompt. Collapse to one line, cap with
 *  an ellipsis. Returns null when there's no usable prompt. */
export function summarizePrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const s = prompt.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > PROMPT_CAP ? s.slice(0, PROMPT_CAP - 1).trimEnd() + '…' : s;
}

// Leading politeness/filler peeled off so the title starts on the real subject.
// Includes the trailing pronouns (me/us/my/our) so "give me …" / "show me …" /
// "tell me …" peel cleanly — without them we'd leave a dangling "me" → "Me The …".
const TITLE_LEAD = /^(can|could|would|will|please|pls|kindly|hey|yo|ok|okay|so|now|first|just|i|i'd|i'll|we|let|lets|let's|help|wanna|want|need|give|gimme|show|tell|do|me|us|my|our)\b[\s,'-]*/i;
// Low-value connectors dropped everywhere (so significant words fill the slots).
const TITLE_STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'with', 'and', 'or', 'me', 'my', 'our', 'your', 'please', 'about', 'that', 'this', 'it', 'on', 'in', 'at', 'is', 'are', 'be', 'as', 'by', 'from', 'into', 'up', 'how']);

/** Instant, free, model-less title from a prompt — peel filler, drop stop-words,
 *  take the first few significant words, lowercase (to match the opencode/LLM
 *  upgrade style so casing never clashes), cap. The renderer floor shown the
 *  moment the operator hits Enter (Cursor's strategy); an opencode/SIGMA::LABEL
 *  title upgrades it later. Always returns a non-empty string. */
export function heuristicTitle(prompt: string | null | undefined): string {
  let s = (prompt ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'new task';
  for (let i = 0; i < 8; i++) { const n = s.replace(TITLE_LEAD, ''); if (n === s) break; s = n; }
  const clause = s.split(/[,.;:\n!?]/)[0].trim();
  const base = clause.length >= 10 ? clause : s;
  let words = base.split(' ').filter(Boolean).filter((w) => !TITLE_STOP.has(w.toLowerCase()));
  if (words.length === 0) words = base.split(' ').filter(Boolean); // all-stops fallback
  let t = words.slice(0, 4).join(' ').replace(/[^\p{L}\p{N}\s'-]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
  t = t.length > PROMPT_CAP ? t.slice(0, PROMPT_CAP).trim() : t;
  return t || summarizePrompt(prompt)?.toLowerCase() || 'new task';
}

const labels = new Map<string, string>();
const subs = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = subs.get(sessionId);
  if (set) for (const cb of set) cb();
}

/** Feed a raw label. Junk is ignored (last good value preserved). */
export function setAgentLabel(sessionId: string, raw: string): void {
  const clean = sanitizeLabel(raw);
  if (clean === null) return;
  if (labels.get(sessionId) === clean) return; // no-op → no notify
  labels.set(sessionId, clean);
  notify(sessionId);
}

/** Snapshot for useSyncExternalStore (stable string | null). */
export function getAgentLabel(sessionId: string): string | null {
  return labels.get(sessionId) ?? null;
}

export function subscribeAgentLabel(sessionId: string, cb: () => void): () => void {
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

/** Permanent removal (pane closed). Clears the value and notifies. */
export function clearAgentLabel(sessionId: string): void {
  if (!labels.has(sessionId)) return;
  labels.delete(sessionId);
  notify(sessionId);
}

/** Test-only: wipe all labels. */
export function __resetAgentLabels(): void {
  labels.clear();
}
