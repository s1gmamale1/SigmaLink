// Per-pane SIGMA::LABEL watcher — the Claude-auto-label source. Mirrors
// prompt-watcher.ts: a persistent pty-data-bus subscription + ProtocolLineBuffer
// that survives React unmounts (the bus has no replay). Unlike prompt-watcher
// it owns no state — it feeds the pane-labels store directly. Disposed by the
// terminal-cache GC when the session leaves app state.
//
// ProtocolLineBuffer is a pure module (no node/electron deps); prompt-watcher
// already imports it from the same path, so there is no bundling hazard.

import { ProtocolLineBuffer } from '@/main/core/swarms/protocol';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';
import { setAgentLabel } from '@/renderer/lib/pane-labels';

const LABEL_LINE = /^SIGMA::LABEL\s+(.+)$/;

const watchers = new Map<string, { off: () => void }>();

/** Install the persistent watcher for a session (idempotent). */
export function ensureLabelWatcher(sessionId: string): void {
  if (watchers.has(sessionId)) return;
  const buf = new ProtocolLineBuffer();
  const off = subscribePtyData(sessionId, ({ data }) => {
    buf.push(data, (line) => {
      const m = LABEL_LINE.exec(line.trim());
      if (m) setAgentLabel(sessionId, m[1]);
    });
  });
  watchers.set(sessionId, { off });
}

/** Tear down a session's watcher. Idempotent; called by the GC. */
export function disposeLabelWatcher(sessionId: string): void {
  const w = watchers.get(sessionId);
  if (!w) return;
  try {
    w.off();
  } catch {
    /* bus already reset — ignore */
  }
  watchers.delete(sessionId);
}

/** Test-only: wipe all watchers. */
export function __resetLabelWatchers(): void {
  for (const id of Array.from(watchers.keys())) disposeLabelWatcher(id);
}
