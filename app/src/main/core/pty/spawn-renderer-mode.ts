// P1c — resolve a pane's renderer mode at SPAWN time, main-side. Mirrors the
// renderer's resolution order (renderer-flag.ts): per-session KV override →
// global default KV → shared DEFAULT_RENDERER_MODE. Reads the kv table
// directly (the resume-launcher/ram-brake pattern); any failure falls back
// to the shared default — a wrong-but-consistent renderer beats a crash in
// the spawn path.

import type Database from 'better-sqlite3';
import {
  DEFAULT_RENDERER_MODE,
  parseRendererMode,
  RENDERER_DEFAULT_KEY,
  rendererSessionKey,
  type RendererMode,
} from '../../../shared/renderer-mode';

function readKv(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * `sessionId` is the SigmaLink session row id when known (resume/respawn —
 * a per-session override may exist); fresh spawns pass their pre-allocated
 * id or undefined (no override can exist yet — global/default applies).
 */
export function resolveSpawnRendererMode(
  db: Database.Database,
  sessionId?: string | null,
): RendererMode {
  if (sessionId) {
    const per = parseRendererMode(readKv(db, rendererSessionKey(sessionId)));
    if (per) return per;
  }
  return parseRendererMode(readKv(db, RENDERER_DEFAULT_KEY)) ?? DEFAULT_RENDERER_MODE;
}
