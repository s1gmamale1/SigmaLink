// Pane title orchestrator — decides the LABEL for each pane from two sources,
// provider-agnostically:
//
//   1. Agent self-label (SIGMA::LABEL) — Claude emits it; label-reader routes it
//      here via onAgentLabel(). Highest quality; wins instantly and cancels any
//      pending summary.
//   2. Haiku summarizer — for providers that DON'T self-label (codex/gemini/
//      cursor) or a Claude pane that hasn't emitted yet. On a submitted prompt we
//      show a "titling…" placeholder, wait TITLE_WAIT_MS for a SIGMA::LABEL, and
//      if none arrives call rpc.paneTitle.summarize (one-shot `claude -p haiku`).
//
// The raw prompt is NO LONGER a sticky label — only the source for the summary,
// with a truncated-prompt fallback if the summarizer fails. A new prompt RESETS
// the cycle (re-title every prompt). A per-session generation counter drops stale
// timers/in-flight summaries when a newer prompt or an agent label supersedes.
//
// Single writer to the pane-labels store (setAgentLabel) for the LABEL slot.

import { setAgentLabel, summarizePrompt } from '@/renderer/lib/pane-labels';
import { rpcSilent } from '@/renderer/lib/rpc';

export const TITLE_WAIT_MS = 3_000;

interface TitleState {
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
  prompt: string;
}

const states = new Map<string, TitleState>();
const pending = new Map<string, boolean>();
const pendingSubs = new Map<string, Set<() => void>>();

function notifyPending(sessionId: string): void {
  const set = pendingSubs.get(sessionId);
  if (set) for (const cb of set) cb();
}

function setPending(sessionId: string, value: boolean): void {
  if ((pending.get(sessionId) ?? false) === value) return;
  if (value) pending.set(sessionId, true);
  else pending.delete(sessionId);
  notifyPending(sessionId);
}

/** True while a title is being resolved (show the "titling…" placeholder). */
export function isPaneTitlePending(sessionId: string): boolean {
  return pending.get(sessionId) ?? false;
}

export function subscribePaneTitlePending(sessionId: string, cb: () => void): () => void {
  let set = pendingSubs.get(sessionId);
  if (!set) { set = new Set(); pendingSubs.set(sessionId, set); }
  set.add(cb);
  return () => {
    const s = pendingSubs.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) pendingSubs.delete(sessionId);
  };
}

/** A submitted prompt — start the title cycle (placeholder + summary fallback). */
export function onPrompt(sessionId: string, promptText: string): void {
  const clean = promptText.trim();
  if (!clean) return;
  const prev = states.get(sessionId);
  if (prev?.timer) clearTimeout(prev.timer);
  const gen = (prev?.gen ?? 0) + 1;
  setPending(sessionId, true);
  const timer = setTimeout(() => { void runSummary(sessionId, gen); }, TITLE_WAIT_MS);
  states.set(sessionId, { gen, timer, prompt: clean });
}

async function runSummary(sessionId: string, gen: number): Promise<void> {
  const st = states.get(sessionId);
  if (!st || st.gen !== gen) return; // superseded by a newer prompt / agent label
  st.timer = null;
  if (!isPaneTitlePending(sessionId)) return; // an agent label already resolved it

  let title: string | null = null;
  try {
    const r = await rpcSilent.paneTitle.summarize({ text: st.prompt });
    title = r?.title ?? null;
  } catch {
    title = null;
  }

  // Re-check after the await: a newer prompt or an agent label may have landed.
  const cur = states.get(sessionId);
  if (!cur || cur.gen !== gen) return;
  if (!isPaneTitlePending(sessionId)) return;

  // Summary, else a truncated-prompt fallback (never the full raw prompt).
  const label = title ?? summarizePrompt(st.prompt) ?? st.prompt.slice(0, 60);
  setAgentLabel(sessionId, label);
  setPending(sessionId, false);
}

/** A SIGMA::LABEL arrived (from label-reader) — it wins instantly. */
export function onAgentLabel(sessionId: string, text: string): void {
  const st = states.get(sessionId);
  if (st) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.gen += 1; // invalidate any in-flight summary for this session
  }
  setPending(sessionId, false);
  setAgentLabel(sessionId, text);
}

/** Permanent removal (pane closed). Clears timer + pending. The LABEL itself is
 *  cleared via clearAgentLabel in the GC hook. */
export function clearPaneTitle(sessionId: string): void {
  const st = states.get(sessionId);
  if (st?.timer) clearTimeout(st.timer);
  states.delete(sessionId);
  setPending(sessionId, false);
}

/** Test-only: wipe all orchestrator state. */
export function __resetPaneTitleOrchestrator(): void {
  for (const st of states.values()) if (st.timer) clearTimeout(st.timer);
  states.clear();
  pending.clear();
}
