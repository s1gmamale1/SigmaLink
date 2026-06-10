// 2026-06-10 lifecycle audit, finding 1 — module-scope scratch-tab registry.
//
// W-4 Phase 4 put scratch-shell sub-tab state in a per-mount useState inside
// PaneShell. Every room/workspace switch unmounted PaneShell and reset that
// state, orphaning the scratch PTY in main (no UI handle) and leaking its
// cached xterm + pty-bus subscription until 32-entry LRU eviction.
//
// This store is the same module-singleton pattern as terminal-cache.ts and
// pty-data-bus.ts (hasPtyDataArrived): scratch tabs are keyed by their PARENT
// sessionId and survive React unmounts, consistent with the terminal-
// multiplexer mental model (the main terminal survives a switch; the scratch
// shell next to it must too).
//
// Teardown choke point: closeScratchTab() removes the tab, destroys the
// cached xterm (so the terminal-cache entry + bus subscription + renderer
// resources go with it — finding 1c), and kills the PTY in main. Parent-level
// cleanup (pane close / relaunch / exited-grace GC — all three REMOVE_SESSION
// dispatch sites) funnels through use-terminal-cache-gc → closeScratchForParent.

import { rpc } from '@/renderer/lib/rpc';
import { destroy as destroyCachedTerminal } from '@/renderer/lib/terminal-cache';

export interface ScratchTab {
  scratchId: string;
}

const tabsByParent = new Map<string, ScratchTab[]>();
const listenersByParent = new Map<string, Set<() => void>>();
// One stable empty array so useSyncExternalStore snapshots don't loop on a
// fresh [] identity every render for parents with no tabs.
const EMPTY_TABS: ScratchTab[] = [];

function notify(parentId: string): void {
  const set = listenersByParent.get(parentId);
  if (!set) return;
  // Snapshot before dispatch — a subscriber may synchronously unsubscribe.
  for (const fn of Array.from(set)) fn();
}

/** Current scratch tabs for a parent session. Stable reference between mutations. */
export function getScratchTabs(parentId: string): ScratchTab[] {
  return tabsByParent.get(parentId) ?? EMPTY_TABS;
}

/** Subscribe to tab-list changes for one parent. Returns an unsubscribe fn. */
export function subscribeScratchTabs(parentId: string, fn: () => void): () => void {
  let set = listenersByParent.get(parentId);
  if (!set) {
    set = new Set();
    listenersByParent.set(parentId, set);
  }
  set.add(fn);
  return () => {
    const cur = listenersByParent.get(parentId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listenersByParent.delete(parentId);
  };
}

/** Register a freshly spawned scratch PTY under its parent session. */
export function addScratchTab(parentId: string, scratchId: string): void {
  tabsByParent.set(parentId, [...getScratchTabs(parentId), { scratchId }]);
  notify(parentId);
}

/**
 * Close one scratch tab: remove from the store, destroy the cached xterm
 * (terminal-cache entry + pty-bus subscription), kill the PTY in main.
 * Idempotent — unknown ids are a no-op.
 */
export function closeScratchTab(parentId: string, scratchId: string): void {
  const cur = tabsByParent.get(parentId);
  if (!cur || !cur.some((t) => t.scratchId === scratchId)) return;
  const next = cur.filter((t) => t.scratchId !== scratchId);
  if (next.length === 0) tabsByParent.delete(parentId);
  else tabsByParent.set(parentId, next);
  destroyCachedTerminal(scratchId);
  void rpc.pty.killScratch({ scratchId }).catch(() => undefined);
  notify(parentId);
}

/** Close every scratch tab of a parent (parent session removed from state). */
export function closeScratchForParent(parentId: string): void {
  const cur = tabsByParent.get(parentId);
  if (!cur) return;
  for (const tab of [...cur]) closeScratchTab(parentId, tab.scratchId);
}

/** Parents that currently own scratch tabs (GC orphan sweep). */
export function getScratchParentIds(): string[] {
  return Array.from(tabsByParent.keys());
}

/** Test-only: wipe all store state (does NOT kill PTYs / destroy terminals). */
export function __resetScratchTabs(): void {
  tabsByParent.clear();
  listenersByParent.clear();
}
