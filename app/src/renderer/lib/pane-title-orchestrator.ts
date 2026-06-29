// Pane title orchestrator. Decides the LABEL for each pane, free + provider-agnostic:
//
//   onPrompt → set an INSTANT heuristic title (cleaned first words) so the pane is
//     never blank/raw, then after a short grace window upgrade it via the opencode
//     summarizer (rpc.paneTitle.summarize → `opencode run`, free) UNLESS a
//     SIGMA::LABEL already arrived.
//   onAgentLabel → a SIGMA::LABEL from the pane's own agent (label-reader); the
//     cleanest source — it wins instantly and cancels the summarizer. Deduped so a
//     stale buffered sentinel re-firing on a later prompt can't clobber the title.
//
// Single writer to the pane-labels store (setAgentLabel). A per-session generation
// counter drops stale timers / in-flight summaries when a newer prompt or a fresh
// SIGMA::LABEL supersedes.

import { setAgentLabel, heuristicTitle } from '@/renderer/lib/pane-labels';
import { rpcSilent } from '@/renderer/lib/rpc';

// Grace window: let a self-labeling agent (claude) emit SIGMA::LABEL before we
// spend an opencode call. Non-self-labelers just wait this out then get the summary.
export const TITLE_WAIT_MS = 3_000;

interface TitleState {
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
  prompt: string;
}

const states = new Map<string, TitleState>();
// Last SIGMA::LABEL value consumed per session — dedupes the label-reader re-firing
// the SAME sentinel (still in scrollback) after a new prompt set the heuristic.
const lastAgentLabel = new Map<string, string>();

/** A submitted prompt — set the instant heuristic, schedule the summarizer upgrade. */
export function onPrompt(sessionId: string, promptText: string): void {
  const clean = promptText.trim();
  if (!clean) return;
  const prev = states.get(sessionId);
  if (prev?.timer) clearTimeout(prev.timer);
  const gen = (prev?.gen ?? 0) + 1;
  // Instant floor — never blank, never the raw ramble.
  setAgentLabel(sessionId, heuristicTitle(clean));
  const timer = setTimeout(() => { void runSummary(sessionId, gen); }, TITLE_WAIT_MS);
  states.set(sessionId, { gen, timer, prompt: clean });
}

async function runSummary(sessionId: string, gen: number): Promise<void> {
  const st = states.get(sessionId);
  if (!st || st.gen !== gen) return; // superseded by a newer prompt or a SIGMA::LABEL
  st.timer = null;

  let title: string | null = null;
  try {
    const r = await rpcSilent.paneTitle.summarize({ text: st.prompt });
    title = r?.title ?? null;
  } catch {
    title = null;
  }

  const cur = states.get(sessionId);
  if (!cur || cur.gen !== gen) return; // a newer prompt / SIGMA::LABEL landed mid-await
  if (title) setAgentLabel(sessionId, title); // else keep the heuristic floor
}

/** A SIGMA::LABEL arrived from the pane's own agent (label-reader). Cleanest source. */
export function onAgentLabel(sessionId: string, text: string): void {
  if (lastAgentLabel.get(sessionId) === text) return; // stale buffered re-fire — ignore
  lastAgentLabel.set(sessionId, text);
  const st = states.get(sessionId);
  if (st) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.gen += 1; // invalidate any in-flight summary
  }
  setAgentLabel(sessionId, text);
}

/** Permanent removal (pane closed). The LABEL itself is cleared via clearAgentLabel. */
export function clearPaneTitle(sessionId: string): void {
  const st = states.get(sessionId);
  if (st?.timer) clearTimeout(st.timer);
  states.delete(sessionId);
  lastAgentLabel.delete(sessionId);
}

/** Test-only: wipe all orchestrator state. */
export function __resetPaneTitleOrchestrator(): void {
  for (const st of states.values()) if (st.timer) clearTimeout(st.timer);
  states.clear();
  lastAgentLabel.clear();
}
