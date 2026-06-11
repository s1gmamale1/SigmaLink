# Ctrl+Scroll Font Zoom — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming complete) → ready for implementation plan
**Scope:** Add browser-style "zoom the whole app" via Ctrl/Cmd+scroll and keyboard shortcuts, persisted across restarts. Bundles a one-line fix for a latent `app.fontSize` cold-boot bug found during recon.

---

## 1. Goal & decisions

Users want to make the app text bigger/smaller with **Ctrl/Cmd + mouse wheel**, like every browser and VSCode.

Decisions locked during brainstorming:

| Decision | Choice |
|---|---|
| **What scales** | Whole app, browser-style — Electron native zoom (`webFrame.setZoomFactor`). Scales React DOM, xterm terminal canvas, Monaco, chrome labels, icons, spacing — uniformly, in one shot. |
| **Triggers** | Ctrl/Cmd + scroll; plus Cmd/Ctrl + `=` (in), `-` (out), `0` (reset to 100%). |
| **Range** | 50%–200% (factor `0.5`–`2.0`), browser-standard clamp. |
| **Indicator** | Brief `120%` pill, fades after ~1s (resets timer on each change). |
| **Persistence** | Global KV key `app.zoomFactor`, restored on cold boot. |
| **Bundled fix** | `app.fontSize` cold-boot restore (currently only re-applied when Settings opens). |

### Why native zoom over a CSS font-scale

Recon found **three independent font systems**: React rooms (`html { font-size }`, rem-based), xterm terminals (`fontSize:12` hardcoded in `terminal-cache.ts`, CSS-independent), and Monaco (`fontSize:12`, CSS-independent). A CSS-only approach would need all three wired separately and would still **miss** the many hardcoded `text-[10px]` chrome labels. `webFrame.setZoomFactor` scales the entire main webContents — all three systems plus px-chrome — with one call. Lowest bug surface, most complete.

### Scope boundaries (intentionally NOT in scope)

- **Browser room's embedded `WebContentsView`** is a *separate* webContents → unaffected by main-frame zoom. Correct & intended: browsed websites keep their own zoom.
- `app.fontSize` (the Settings "base font size" knob) and zoom **compose** like browser page-font-size × browser-zoom. Both kept, independent. We do not remove or merge them.
- No per-workspace zoom. Zoom is one global value (matches `app.fontSize`/`app.theme`/`app.density`).

---

## 2. Architecture

Renderer-owned controller. Native zoom is a renderer-process API (`webFrame`), exposed through the existing contextIsolation-safe preload bridge. No main-process IPC round-trip per scroll notch → instant.

```
gesture (wheel / key)
   └─> useZoomControls hook (mounted once at App root)
          └─> lib/zoom.ts  (clamp + math + persist, DOM-free/testable)
                 ├─> window.sigma.setZoomFactor(f)   ← instant native zoom
                 ├─> rpcSilent.kv.set('app.zoomFactor', f)   ← debounced persist
                 └─> zoom HUD show(%) + schedule fade

boot:
   ThemeProvider hydrate effect
       └─> rpc.kv.get('app.zoomFactor') → applyZoom(f)
       └─> rpc.kv.get('app.fontSize')   → applyFontSize(n)   ← bundled bugfix
```

---

## 3. Components (each small, single-purpose)

### 3.1 Preload zoom bridge — `electron/preload.ts`

Add `webFrame` import and two methods to the existing `api` object (auto-typed via `SigmaPreloadApi` → `window.sigma`; **no new global decl** needed — `src/types/electron.d.ts` already maps `window.sigma` to `SigmaPreloadApi`):

```ts
import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron';
// ...inside `const api = { ... }`:
  getZoomFactor: (): number => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number): void => {
    webFrame.setZoomFactor(factor);
  },
```

`webFrame` runs in the renderer process; preload has access. Renderer reaches it via `window.sigma.setZoomFactor(f)`.

### 3.2 `lib/zoom.ts` — NEW controller (DOM-free, testable)

```ts
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_DEFAULT = 1.0;
export const ZOOM_KV_KEY = 'app.zoomFactor';

export const clampZoom = (f: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(f) ? f : ZOOM_DEFAULT));

let current = ZOOM_DEFAULT;

export function getZoom(): number { return current; }

export function applyZoom(f: number): number {
  current = clampZoom(f);
  // Guard: window.sigma may be absent in tests / very early boot. Never throw.
  try { window.sigma?.setZoomFactor?.(current); } catch { /* no-op */ }
  return current;
}

// Smooth, trackpad-friendly, matches the existing Constellation idiom
// (Constellation.tsx uses Math.exp(-deltaY * 0.0015) for canvas zoom).
export function zoomByWheel(deltaY: number): number {
  return applyZoom(current * Math.exp(-deltaY * 0.001));
}
export function zoomIn(): number  { return applyZoom(current + 0.1); }
export function zoomOut(): number { return applyZoom(current - 0.1); }
export function resetZoom(): number { return applyZoom(ZOOM_DEFAULT); }

// Persistence (debounced, silent — matches app KV idiom).
let persistT: ReturnType<typeof setTimeout> | null = null;
export function persistZoom(f: number): void {
  if (persistT) clearTimeout(persistT);
  persistT = setTimeout(() => {
    void rpcSilent.kv.set(ZOOM_KV_KEY, String(clampZoom(f))).catch(() => undefined);
  }, 250);
}

export async function loadPersistedZoom(): Promise<number> {
  try {
    const raw = await rpc.kv.get(ZOOM_KV_KEY);
    const parsed = raw == null ? ZOOM_DEFAULT : Number(raw);
    return applyZoom(parsed);   // clamp guards a corrupt value
  } catch { return applyZoom(ZOOM_DEFAULT); }
}
```

A tiny pub/sub (or callback registered by the HUD) emits the current % on each apply so the HUD can render without prop-drilling. Implementation detail left to the plan (a 5-line emitter or a small Zustand-style store; the app already has lightweight state patterns).

### 3.3 `useZoomControls` hook — NEW, mounted once in `App`

`App` is the root, never unmounts (recon: `App.tsx:284`, alongside the existing `prefetchRooms` effect).

- **wheel** listener on `window`, `{ passive: false }`:
  ```ts
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();              // suppress Chromium's native Ctrl+wheel zoom — we own it
    const f = zoomByWheel(e.deltaY);
    persistZoom(f);
    showHud(f);
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  ```
- **keyboard** via the existing `bindShortcut` helper (`lib/shortcuts.ts`, the app's idiom): `Mod+=` / `Mod++` → `zoomIn`; `Mod+-` / `Mod+_` → `zoomOut`; `Mod+0` → `resetZoom`. Each followed by `persistZoom` + `showHud`.
- cleanup removes all listeners on unmount.

### 3.4 Zoom HUD — NEW `ZoomIndicator.tsx`, rendered at App root

- Fixed-position pill, `pointer-events-none`, high z-index, `${Math.round(factor*100)}%`.
- Subscribes to the zoom emitter; on each event shows itself and (re)starts a ~1000ms fade-out timer.
- Uses the app's existing motion utilities / spring easing (`--ease-snappy` in `index.css`). Respects `prefers-reduced-motion` (fade → instant).

### 3.5 xterm escape hatch — `lib/terminal-cache.ts`

In the cache-miss path (after `new XTerm(...)` / `term.open(...)`, ~line 282):

```ts
term.attachCustomWheelEventHandler((ev) => !(ev.ctrlKey || ev.metaKey));
```

Returning `false` for Ctrl/Cmd+wheel suppresses xterm's scrollback for that event; the event still bubbles to the `window` listener which owns zoom. (Official xterm 6 escape hatch; not currently used anywhere.)

### 3.6 Boot restore + bundled `app.fontSize` fix — `ThemeProvider.tsx` + `themes.ts`

`themes.ts`: add `fontSize: 'app.fontSize'` and `zoomFactor: 'app.zoomFactor'` to `KV_KEYS` (currently only `theme`/`onboarded`/`sidebarCollapsed`/`density`).

`ThemeProvider.tsx` hydrate effect (the `Promise.all` at line 46): also fetch both keys and apply:

```ts
const [storedTheme, storedDensity, storedFont, storedZoom] = await Promise.all([
  rpc.kv.get(KV_KEYS.theme),
  rpc.kv.get(KV_KEYS.density).catch(() => null),
  rpc.kv.get(KV_KEYS.fontSize).catch(() => null),   // BUGFIX: was only applied on Settings open
  rpc.kv.get(KV_KEYS.zoomFactor).catch(() => null),
]);
// ...after theme/density:
if (storedFont != null) { const n = Number(storedFont); if (Number.isFinite(n)) applyFontSize(n); }
applyZoom(storedZoom == null ? ZOOM_DEFAULT : Number(storedZoom));
```

`applyFontSize` already exists and is exported (`themes.ts:220`). This makes the Settings → Font size choice survive restarts (today it silently resets to the default each boot).

### 3.7 Constellation guard — `operator-console/Constellation.tsx`

The canvas `onWheel` (~line 663) zooms the viewport on any wheel (no `ctrlKey` check). Add a guard so Ctrl/Cmd+scroll over the canvas does **font zoom**, not canvas zoom:

```ts
const onWheel = (e) => {
  if (e.ctrlKey || e.metaKey) return;   // let the global font-zoom handler take it
  e.preventDefault();
  // ...existing canvas zoom...
};
```

---

## 4. Data flow

1. **Gesture** → hook handler → `zoom.ts` clamps → `window.sigma.setZoomFactor()` (instant) → `persistZoom()` (debounced 250ms KV write) → HUD `show(%)` + fade timer.
2. **Boot** → ThemeProvider hydrate → KV read `app.zoomFactor` + `app.fontSize` → `applyZoom()` / `applyFontSize()`.

---

## 5. Error handling

- `window.sigma` / `setZoomFactor` absent (tests, very early boot): `zoom.ts` optional-chains and `try/catch` → no-op, never throws.
- KV read/write failures: swallowed via `rpcSilent` / `.catch(() => …)`, fall back to `ZOOM_DEFAULT`. Matches app idiom.
- Corrupt KV value: `clampZoom` + `Number.isFinite` guarantee a sane factor; a bad value can never break layout.
- No new IPC channel, no migration (KV table is bootstrap-provisioned). The bridge methods are renderer-local `webFrame` calls, not IPC — no `rpc-channels` allowlist change.

---

## 6. Testing

- **`zoom.test.ts`** (vitest, mock `window.sigma` + `rpcSilent`/`rpc`): `clampZoom` bounds (`0.3→0.5`, `3→2`, `NaN→1`); `zoomByWheel` sign (negative deltaY → larger factor); `zoomIn/zoomOut` ±0.1 + clamp; `resetZoom`→1.0; `persistZoom` debounces & writes a clamped string (fake timers); `loadPersistedZoom` parses + clamps + handles null/throw.
- **hook test** (jsdom): synthetic `wheel` with `ctrlKey` → `setFactor` called + `preventDefault` invoked; wheel without ctrl → no-op; `keydown` Mod+0 → reset. Construct events via `createEvent` + `Object.defineProperty(e,'deltaY'/'ctrlKey',…)` (the list-reorder test idiom).
- **HUD test**: renders rounded %, auto-hides after fake-timer advance; reduced-motion path renders without animation.
- **E2e**: deferred to the CI e2e-matrix (no local live-app e2e per project convention). A smoke assertion can read `window.sigma.getZoomFactor()` after a synthetic Ctrl+wheel.

---

## 7. Files touched

| File | Change | ~LOC |
|---|---|---|
| `electron/preload.ts` | add `getZoomFactor`/`setZoomFactor` to `api` | +5 |
| `src/renderer/lib/zoom.ts` | NEW controller | ~90 |
| `src/renderer/app/useZoomControls.ts` | NEW hook | ~60 |
| `src/renderer/app/ZoomIndicator.tsx` | NEW HUD | ~45 |
| `src/renderer/app/App.tsx` | mount hook + HUD | +4 |
| `src/renderer/lib/terminal-cache.ts` | `attachCustomWheelEventHandler` | +1 |
| `src/renderer/lib/themes.ts` | add `fontSize`/`zoomFactor` to `KV_KEYS` | +2 |
| `src/renderer/app/ThemeProvider.tsx` | boot restore zoom + fontSize fix | +6 |
| `src/renderer/features/operator-console/Constellation.tsx` | ctrl-guard onWheel | +1 |
| `*.test.ts(x)` | 3 test files | ~120 |

Net ~250 LOC. No migration, no new IPC channel.

---

## 8. Open implementation choices (for the plan, not blockers)

- HUD emitter mechanism (tiny pub/sub vs. existing state util) — pick the lightest that fits.
- Keyboard step granularity: flat ±0.1 (chosen) vs. browser-style preset stops (50/67/80/90/100/110/125/150/175/200). Flat is simpler; revisit only if it feels off.
