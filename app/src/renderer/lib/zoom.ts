// Whole-app zoom controller. Holds the current zoom factor, clamps/steps it,
// drives Electron native zoom via the sigma preload bridge, and persists the
// chosen factor to KV. DOM access is isolated to `zoomBridge()` so the module
// is unit-testable by mocking `window.sigma`. HUD notification is a separate
// emitter (subscribeZoom/notifyZoom) so boot restore can apply silently.

import { rpc, rpcSilent } from './rpc';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_DEFAULT = 1.0;
export const ZOOM_STEP = 0.1;
export const ZOOM_KV_KEY = 'app.zoomFactor';

type ZoomBridge = { getZoomFactor(): number; setZoomFactor(factor: number): void };

function zoomBridge(): ZoomBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const s = (window as Window & { sigma?: Partial<ZoomBridge> }).sigma;
  if (!s || typeof s.setZoomFactor !== 'function') return undefined;
  return s as ZoomBridge;
}

export function clampZoom(f: number): number {
  if (!Number.isFinite(f)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, f));
}

let current = ZOOM_DEFAULT;

export function getZoom(): number {
  return current;
}

/** Clamp, store, and push the factor to native zoom. Never throws. */
export function applyZoom(f: number): number {
  current = clampZoom(f);
  try {
    zoomBridge()?.setZoomFactor(current);
  } catch {
    // Bridge call can throw if the frame is mid-teardown; non-fatal.
  }
  return current;
}

/**
 * Smooth, trackpad-friendly wheel step. Mirrors the Constellation canvas idiom
 * (`Math.exp(-deltaY * k)`): a mouse notch (deltaY ≈ ±100) is ~±10%, while
 * fine trackpad deltas produce small smooth steps.
 */
export function zoomByWheel(deltaY: number): number {
  return applyZoom(current * Math.exp(-deltaY * 0.001));
}

export function zoomIn(): number {
  return applyZoom(current + ZOOM_STEP);
}

export function zoomOut(): number {
  return applyZoom(current - ZOOM_STEP);
}

export function resetZoom(): number {
  return applyZoom(ZOOM_DEFAULT);
}

// --- Persistence (debounced, silent — matches the app KV idiom) -------------

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function persistZoom(f: number): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void rpcSilent.kv.set(ZOOM_KV_KEY, String(clampZoom(f))).catch(() => undefined);
  }, 250);
}

/** Boot restore. Applies silently (no HUD). Falls back to default on any error. */
export async function loadPersistedZoom(): Promise<number> {
  try {
    const raw = await rpc.kv.get(ZOOM_KV_KEY);
    return applyZoom(raw == null ? ZOOM_DEFAULT : Number(raw));
  } catch {
    return applyZoom(ZOOM_DEFAULT);
  }
}

// --- HUD emitter ------------------------------------------------------------

type ZoomListener = (percent: number) => void;
const listeners = new Set<ZoomListener>();

export function subscribeZoom(fn: ZoomListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Notify HUD subscribers of the current factor as a rounded percent. */
export function notifyZoom(f: number): void {
  const pct = Math.round(clampZoom(f) * 100);
  for (const l of listeners) l(pct);
}
