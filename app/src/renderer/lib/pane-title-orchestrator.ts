// Pane title orchestrator. ONE source, decoupled from the pane's agent:
//
//   onPrompt → fire the Ollama-cloud summarizer (rpc.paneTitle.summarize) and set
//     the resulting clean title. NO instant heuristic — the pane shows just its
//     NAME for the ~2s until the title lands (zero bs by construction: the label
//     is only ever a clean model title or empty).
//
// A per-session generation counter drops a slow summary from a superseded prompt
// so the latest prompt always wins. onAgentLabel remains as a rare override for an
// agent that voluntarily emits SIGMA::LABEL (the injection is gone, so normally
// unused) — kept so label-reader has a sink.

import { setAgentLabel } from '@/renderer/lib/pane-labels';
import { rpcSilent } from '@/renderer/lib/rpc';

interface TitleState { gen: number; prompt: string }
const states = new Map<string, TitleState>();

/** A submitted prompt — title it via the cloud summarizer (latest prompt wins). */
export function onPrompt(sessionId: string, promptText: string): void {
  const clean = promptText.trim();
  if (!clean) return;
  const gen = (states.get(sessionId)?.gen ?? 0) + 1;
  states.set(sessionId, { gen, prompt: clean });
  void runSummary(sessionId, gen);
}

async function runSummary(sessionId: string, gen: number): Promise<void> {
  const st = states.get(sessionId);
  if (!st || st.gen !== gen) return;

  let title: string | null = null;
  try {
    const r = await rpcSilent.paneTitle.summarize({ text: st.prompt });
    title = r?.title ?? null;
  } catch {
    title = null;
  }

  const cur = states.get(sessionId);
  if (!cur || cur.gen !== gen) return; // a newer prompt superseded this one
  if (title) setAgentLabel(sessionId, title); // else keep the name (no bs fallback)
}

/** Rare override: an agent that voluntarily emits SIGMA::LABEL (injection removed,
 *  so normally never fires). Kept as the label-reader sink. */
export function onAgentLabel(sessionId: string, text: string): void {
  const st = states.get(sessionId);
  if (st) st.gen += 1; // invalidate any in-flight summary
  setAgentLabel(sessionId, text);
}

/** Permanent removal (pane closed). LABEL itself is cleared via clearAgentLabel. */
export function clearPaneTitle(sessionId: string): void {
  states.delete(sessionId);
}

/** Test-only. */
export function __resetPaneTitleOrchestrator(): void {
  states.clear();
}
