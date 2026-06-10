// 2026-06-10 finding 4 — module-scope SIGMA::PROMPT watcher.
//
// use-prompt-card.ts used to subscribe to the pty-data bus only while
// PaneShell was mounted; the bus has no replay (pty-data-bus.ts), so a
// prompt line arriving during a room/workspace switch was lost and the
// card never showed while the CLI blocked on stdin.
//
// This module is the hasPtyDataArrived pattern applied to prompts: once a
// session's watcher is installed (first enabled mount), its bus
// subscription + ProtocolLineBuffer persist across React unmounts, and the
// last valid prompt waits for the next mount. answer/dismiss clear it via
// clearActivePrompt; use-terminal-cache-gc disposes watchers when the
// session vanishes from state.
//
// ProtocolLineBuffer is imported from the shared protocol module — it is a
// pure module (no node/electron deps); the renderer already imports it via
// use-prompt-card.ts, so there is no bundling hazard and no drift risk.

import {
  ProtocolLineBuffer,
  isPromptPayload,
  parseProtocolLine,
  type PromptPayload,
} from '@/main/core/swarms/protocol';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';

const watchers = new Map<string, { off: () => void }>();
const activePrompts = new Map<string, PromptPayload>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const fn of Array.from(set)) fn();
}

/**
 * Install the persistent watcher for a session (idempotent). Called from
 * usePromptCard when the feature is enabled for a mounted pane; the watcher
 * then outlives the mount on purpose.
 */
export function ensurePromptWatcher(sessionId: string): void {
  if (watchers.has(sessionId)) return;
  const buf = new ProtocolLineBuffer();
  const off = subscribePtyData(sessionId, ({ data }) => {
    buf.push(data, (line) => {
      const parsed = parseProtocolLine(line);
      if (!parsed || parsed.verb !== 'PROMPT') return;
      if (!isPromptPayload(parsed.payload)) return;
      // Latest valid prompt wins — a pane asks one question at a time and a
      // newer question supersedes a stale one.
      activePrompts.set(sessionId, parsed.payload);
      notify(sessionId);
    });
  });
  watchers.set(sessionId, { off });
}

/** The pending prompt for a session, or null. */
export function getActivePrompt(sessionId: string): PromptPayload | null {
  return activePrompts.get(sessionId) ?? null;
}

/** Subscribe to active-prompt changes for one session. Returns unsubscribe. */
export function subscribeActivePrompt(sessionId: string, fn: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(sessionId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(sessionId);
  };
}

/** Clear the pending prompt (operator answered or dismissed). */
export function clearActivePrompt(sessionId: string): void {
  if (activePrompts.delete(sessionId)) notify(sessionId);
}

/** Tear down a session's watcher + state. Idempotent; called by the GC. */
export function disposePromptWatcher(sessionId: string): void {
  const w = watchers.get(sessionId);
  if (w) {
    try {
      w.off();
    } catch {
      /* bus already reset — ignore */
    }
    watchers.delete(sessionId);
  }
  if (activePrompts.delete(sessionId)) notify(sessionId);
}

/** Test-only: wipe all watcher state. */
export function __resetPromptWatchers(): void {
  for (const id of Array.from(watchers.keys())) disposePromptWatcher(id);
  activePrompts.clear();
  listeners.clear();
}
