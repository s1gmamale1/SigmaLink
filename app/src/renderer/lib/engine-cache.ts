// DOM terminal presenter P1b — engine-side twin of terminal-cache.ts.
// One headless TerminalEngine per DOM-mode session, owning the PTY bus
// subscription, the race-safe snapshot seed (shared overlap dedup), and the
// exit banner — the same lifecycle contract the xterm cache provides, minus
// DOM parking (a headless engine has no DOM to park).
//
// MUTUAL EXCLUSION: a session must never have BOTH a live engine and a live
// cached xterm — each owns an onData→pty.write pipe, and two pipes would
// double-answer every DA/DSR query. Terminal.tsx's renderer switch is the
// single choke point that destroys the other cache's entry on mode mount.

import { TerminalEngine } from './terminal-engine';
import { rpc } from '@/renderer/lib/rpc';
import { subscribePtyData } from './pty-data-bus';
import { subscribeExit } from './pty-exit-bus';
import { stripDeviceAttributesResponses } from './terminal-cache';
import { computeSnapshotOverlap } from './snapshot-overlap';
import { attachEngineLabelReader, detachLabelReader } from './label-reader';

export const ENGINE_CACHE_LIMIT = 32;

export interface EngineCacheEntry {
  sessionId: string;
  engine: TerminalEngine;
  /** True once the underlying PTY emitted `pty:exit`. */
  ptyExited: boolean;
  /** True after the snapshot resolved and pending chunks drained. */
  snapshotReady: boolean;
  /** True while a DomTerminalView is mounted for this session — such an
   *  entry is never LRU-evicted (destroying it would blank a visible pane). */
  mounted: boolean;
  lastAccessed: number;
  unsubscribePty: () => void;
  offExit: () => void;
}

const cache = new Map<string, EngineCacheEntry>();

function evictOldestIfFull(): void {
  if (cache.size < ENGINE_CACHE_LIMIT) return;
  let exitedVictim: EngineCacheEntry | null = null;
  let liveVictim: EngineCacheEntry | null = null;
  for (const entry of cache.values()) {
    if (entry.mounted) continue;
    if (entry.ptyExited) {
      if (!exitedVictim || entry.lastAccessed < exitedVictim.lastAccessed) exitedVictim = entry;
    } else if (!liveVictim || entry.lastAccessed < liveVictim.lastAccessed) {
      liveVictim = entry;
    }
  }
  const victim = exitedVictim ?? liveVictim;
  if (victim) destroyEngine(victim.sessionId);
}

export function getOrCreateEngine(sessionId: string): EngineCacheEntry {
  const existing = cache.get(sessionId);
  if (existing) {
    existing.lastAccessed = Date.now();
    return existing;
  }
  evictOldestIfFull();

  const engine = new TerminalEngine({
    // SF-3 parity: the engine answers DA/DSR queries via onData exactly like
    // the attached xterm; the same strip applies before the PTY sees stdin.
    writeToPty: (data) => {
      const clean = stripDeviceAttributesResponses(data);
      if (clean === '') return;
      void rpc.pty.write(sessionId, clean).catch(() => undefined);
    },
  });

  const pending: string[] = [];
  let snapshotDone = false;
  const unsubscribePty = subscribePtyData(sessionId, (payload) => {
    if (!cache.has(sessionId)) return;
    if (snapshotDone) engine.write(payload.data);
    else pending.push(payload.data);
  });

  const offExit = subscribeExit(sessionId, (payload) => {
    const entry = cache.get(sessionId);
    if (!entry || entry.ptyExited) return;
    entry.ptyExited = true;
    engine.write(`\r\n\x1b[2;90m[session exited code=${payload.exitCode}]\x1b[0m\r\n`);
  });

  const entry: EngineCacheEntry = {
    sessionId,
    engine,
    ptyExited: false,
    snapshotReady: false,
    mounted: false,
    lastAccessed: Date.now(),
    unsubscribePty,
    offExit,
  };
  cache.set(sessionId, entry);
  // Auto-label — read SIGMA::LABEL from this engine's parsed buffer.
  attachEngineLabelReader(sessionId, engine);

  void (async () => {
    let snapBuffer = '';
    try {
      const snap = await rpc.pty.snapshot(sessionId);
      if (!cache.has(sessionId)) return;
      if (snap.buffer) {
        snapBuffer = snap.buffer;
        engine.write(snapBuffer);
      }
    } catch {
      /* best-effort; the live subscription captured everything since attach */
    }
    let skip = computeSnapshotOverlap(snapBuffer, pending.join(''));
    for (const chunk of pending) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      engine.write(skip > 0 ? chunk.slice(skip) : chunk);
      skip = 0;
    }
    pending.length = 0;
    snapshotDone = true;
    entry.snapshotReady = true;
  })();

  return entry;
}

export function destroyEngine(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) return;
  cache.delete(sessionId);
  detachLabelReader(sessionId, entry.engine);
  try {
    entry.unsubscribePty();
  } catch {
    /* raced teardown — ignore */
  }
  try {
    entry.offExit();
  } catch {
    /* same */
  }
  try {
    entry.engine.dispose();
  } catch {
    /* same */
  }
}

export function getCachedEngine(sessionId: string): EngineCacheEntry | undefined {
  return cache.get(sessionId);
}

export function getEngineCacheSize(): number {
  return cache.size;
}

/** Test-only: wipe every cached engine. */
export function __resetEngineCache(): void {
  for (const id of Array.from(cache.keys())) destroyEngine(id);
}
