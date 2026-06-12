// DOM terminal presenter P1c — renderer-mode constants shared by BOTH sides.
// The renderer's flag resolution (renderer-flag.ts) and the MAIN process's
// spawn-time decision (omit the claude fullscreen injection for DOM panes)
// must agree on keys, parsing, and the unset default — one drifting default
// would silently re-split install behavior from dogfood behavior (the v2.4.1
// lesson). Pure module: no Electron, no DB, no DOM.

export type RendererMode = 'xterm' | 'dom';

/** Global default KV key; per-session overrides use rendererSessionKey(). */
export const RENDERER_DEFAULT_KEY = 'panes.renderer.default';

/** The renderer when no KV is set anywhere (v2.4.1 flipped this to 'dom'). */
export const DEFAULT_RENDERER_MODE: RendererMode = 'dom';

export function rendererSessionKey(sessionId: string): string {
  return `panes.renderer.${sessionId}`;
}

export function parseRendererMode(raw: unknown): RendererMode | null {
  return raw === 'dom' || raw === 'xterm' ? raw : null;
}
