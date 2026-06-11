// DOM terminal presenter P1b — which renderer hosts a pane (spec §Renderer
// flag & fallback). Per-session KV override, then the global default, then
// 'xterm' (the battle-tested fallback). Resolutions are module-cached so a
// REMOUNT (workspace/room switch) renders the right host synchronously with
// no async flash — the remount-overlay lesson (PaneSplash whiteout #131).
//
// Stored as plain KV (`panes.renderer.<sessionId>`), NOT an agent_sessions
// column: the sessions table already has SIX mirror sites for its column
// list (sync COLUMN_ALLOWLIST drift class, P13); a renderer preference does
// not earn a seventh.

import { rpc, rpcSilent } from '@/renderer/lib/rpc';

export type RendererMode = 'xterm' | 'dom';

export const RENDERER_DEFAULT_KEY = 'panes.renderer.default';

export function rendererSessionKey(sessionId: string): string {
  return `panes.renderer.${sessionId}`;
}

const resolved = new Map<string, RendererMode>();

function parseMode(raw: unknown): RendererMode | null {
  return raw === 'dom' || raw === 'xterm' ? raw : null;
}

/** Sync cache read — null until the first resolveRendererMode for the id. */
export function peekRendererMode(sessionId: string): RendererMode | null {
  return resolved.get(sessionId) ?? null;
}

export async function resolveRendererMode(sessionId: string): Promise<RendererMode> {
  const hit = resolved.get(sessionId);
  if (hit) return hit;
  let mode: RendererMode = 'xterm';
  try {
    const per = parseMode(await rpcSilent.kv.get(rendererSessionKey(sessionId)));
    if (per) {
      mode = per;
    } else {
      const def = parseMode(await rpcSilent.kv.get(RENDERER_DEFAULT_KEY));
      if (def) mode = def;
    }
  } catch {
    /* kv unreachable → xterm, the safe fallback */
  }
  resolved.set(sessionId, mode);
  return mode;
}

/** Persist a per-pane override (P1c context menu will call this; available
 *  now for dogfood via console). Cache updates first so the next mount is
 *  correct even if the KV write fails. */
export async function setSessionRendererMode(sessionId: string, mode: RendererMode): Promise<void> {
  resolved.set(sessionId, mode);
  try {
    await rpc.kv.set(rendererSessionKey(sessionId), mode);
  } catch {
    /* best-effort persistence */
  }
}

/** Test-only. */
export function __resetRendererFlagCache(): void {
  resolved.clear();
}
