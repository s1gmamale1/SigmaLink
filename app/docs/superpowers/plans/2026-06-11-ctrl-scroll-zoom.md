# Ctrl+Scroll Font Zoom — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-style whole-app zoom via Ctrl/Cmd+scroll and Cmd/Ctrl + `=`/`-`/`0`, clamped 50–200%, with a brief `%` HUD, persisted across restarts; bundle a fix for the latent `app.fontSize` cold-boot bug.

**Architecture:** A renderer-owned controller (`lib/zoom.ts`) holds zoom state, math, and persistence. It drives Electron native zoom (`webFrame.setZoomFactor`) through a new method on the existing `sigma` preload bridge — instant, no per-notch IPC. A root-mounted hook (`useZoomControls`) wires the `window` wheel + keyboard listeners; a root-mounted HUD subscribes to a tiny emitter. xterm gets an `attachCustomWheelEventHandler` so Ctrl+scroll over a terminal bubbles to zoom instead of scrolling scrollback. Boot restore lives in `ThemeProvider` alongside theme/density (also fixing `app.fontSize` restore).

**Tech Stack:** Electron `webFrame`, React 19, TypeScript (strict), vitest 4 + @testing-library/react + jsdom, the app's `rpc`/`rpcSilent` KV client, `bindShortcut` helper.

**Spec:** `docs/superpowers/specs/2026-06-11-ctrl-scroll-zoom-design.md`

**Conventions for every task:**
- Run a single test file with: `npx vitest run <path>`
- Lint a touched file with: `npx eslint <path>`
- Full gate (end only): `npm test` → `npx eslint .` → `npm run build`
- `@/` resolves to `src/`. Tests that touch the preload bridge mock `window.sigma`; tests that touch persistence `vi.mock('@/renderer/lib/rpc', …)`. Never open a real DB (better-sqlite3 is built for Electron's ABI and won't load in vitest).

---

## File Structure

| File | Responsibility |
|---|---|
| `electron/preload.ts` (modify) | Expose `getZoomFactor`/`setZoomFactor` (renderer-side `webFrame`) on the `sigma` bridge. |
| `src/renderer/lib/zoom.ts` (create) | Zoom state, clamp/step math, native apply, debounced persist, HUD emitter, boot load. |
| `src/renderer/lib/zoom.test.ts` (create) | Unit tests for the controller. |
| `src/renderer/lib/wheel-zoom.ts` (create) | One pure predicate `ctrlWheelShouldBubble(ev)` shared by xterm + Constellation, so the gesture rule is testable. |
| `src/renderer/lib/wheel-zoom.test.ts` (create) | Unit test for the predicate. |
| `src/renderer/app/useZoomControls.ts` (create) | Root hook: `window` wheel + keyboard listeners → controller. |
| `src/renderer/app/useZoomControls.test.tsx` (create) | jsdom tests for the hook. |
| `src/renderer/app/ZoomIndicator.tsx` (create) | Transient `%` HUD pill subscribed to the emitter. |
| `src/renderer/app/ZoomIndicator.test.tsx` (create) | jsdom + fake-timer tests for the HUD. |
| `src/renderer/app/App.tsx` (modify) | Call `useZoomControls()`; mount `<ZoomIndicator />`. |
| `src/renderer/lib/terminal-cache.ts` (modify) | `attachCustomWheelEventHandler(ctrlWheelShouldBubble)` on cache-miss. |
| `src/renderer/lib/themes.ts` (modify) | Add `fontSize`/`zoomFactor` to `KV_KEYS`. |
| `src/renderer/app/ThemeProvider.tsx` (modify) | Boot-restore zoom + fontSize. |
| `src/renderer/app/ThemeProvider.zoom.test.tsx` (create) | Boot-restore test. |
| `src/renderer/features/operator-console/Constellation.tsx` (modify) | Ctrl-guard the canvas `onWheel`. |

---

## Task 1: Preload zoom bridge

**Files:**
- Modify: `electron/preload.ts:6` (import) and `electron/preload.ts:42` (api object)

The preload runs in the renderer process, so `webFrame` is available there. Adding methods to `api` auto-extends `SigmaPreloadApi`, so `window.sigma.setZoomFactor` is typed in the renderer with no extra declaration (`src/types/electron.d.ts` already maps `window.sigma` → `SigmaPreloadApi`). This is a bridge change with no isolated unit test (Electron module); it is verified by the type build in later tasks and by `zoom.ts` mocking `window.sigma`.

- [ ] **Step 1: Add `webFrame` to the electron import**

Change `electron/preload.ts:6` from:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';
```

to:

```ts
import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron';
```

- [ ] **Step 2: Add the two zoom methods to the `api` object**

In `electron/preload.ts`, inside `const api = { … }`, immediately after the `platform: process.platform as NodeJS.Platform,` line (currently line 42), add:

```ts
  // Renderer-side native zoom. webFrame is a renderer-process module; exposing
  // get/set here lets the renderer drive whole-window zoom (React DOM + xterm
  // canvas + Monaco) with no per-event IPC round-trip. factor 1.0 = 100%.
  getZoomFactor: (): number => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number): void => {
    webFrame.setZoomFactor(factor);
  },
```

- [ ] **Step 3: Type-check the preload + renderer typing**

Run: `npx tsc -b`
Expected: PASS (no errors). `SigmaPreloadApi` now includes the two methods.

- [ ] **Step 4: Commit**

```bash
git add electron/preload.ts
git commit -m "feat(zoom): expose webFrame zoom on the sigma preload bridge"
```

---

## Task 2: `lib/zoom.ts` controller (TDD)

**Files:**
- Create: `src/renderer/lib/zoom.ts`
- Test: `src/renderer/lib/zoom.test.ts`

The controller is DOM-light and fully unit-testable by mocking `window.sigma` and the `rpc` module.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/lib/zoom.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the KV client BEFORE importing the module under test.
const kvGet = vi.fn<(k: string) => Promise<string | null>>();
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: (k: string) => kvGet(k) } },
  rpcSilent: { kv: { set: (k: string, v: string) => kvSet(k, v) } },
}));

import {
  ZOOM_DEFAULT,
  ZOOM_KV_KEY,
  ZOOM_MAX,
  ZOOM_MIN,
  applyZoom,
  clampZoom,
  getZoom,
  loadPersistedZoom,
  persistZoom,
  resetZoom,
  zoomByWheel,
  zoomIn,
  zoomOut,
} from './zoom';

const setZoomFactor = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  setZoomFactor.mockClear();
  kvGet.mockReset();
  kvSet.mockReset().mockResolvedValue(undefined);
  (window as unknown as { sigma: { setZoomFactor: typeof setZoomFactor; getZoomFactor: () => number } }).sigma = {
    setZoomFactor,
    getZoomFactor: () => 1,
  };
  resetZoom(); // normalise module state to 1.0 between tests
  setZoomFactor.mockClear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('clampZoom', () => {
  it('clamps below min, above max, and coerces NaN to default', () => {
    expect(clampZoom(0.3)).toBe(ZOOM_MIN);
    expect(clampZoom(3)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(1.25)).toBe(1.25);
  });
});

describe('applyZoom', () => {
  it('clamps, stores, and drives the native bridge', () => {
    expect(applyZoom(1.5)).toBe(1.5);
    expect(getZoom()).toBe(1.5);
    expect(setZoomFactor).toHaveBeenCalledWith(1.5);
    applyZoom(99);
    expect(setZoomFactor).toHaveBeenLastCalledWith(ZOOM_MAX);
  });

  it('never throws when the bridge is absent', () => {
    delete (window as unknown as { sigma?: unknown }).sigma;
    expect(() => applyZoom(1.2)).not.toThrow();
    expect(getZoom()).toBe(1.2);
  });
});

describe('step helpers', () => {
  it('zoomByWheel grows on negative deltaY and shrinks on positive', () => {
    const up = zoomByWheel(-100);
    expect(up).toBeGreaterThan(1);
    resetZoom();
    const down = zoomByWheel(100);
    expect(down).toBeLessThan(1);
  });

  it('zoomIn/zoomOut step by 0.1 and reset returns to default', () => {
    expect(zoomIn()).toBeCloseTo(1.1, 5);
    expect(zoomOut()).toBeCloseTo(1.0, 5);
    applyZoom(1.7);
    expect(resetZoom()).toBe(ZOOM_DEFAULT);
  });
});

describe('persistZoom', () => {
  it('debounces and writes a clamped string to KV', () => {
    persistZoom(1.4);
    persistZoom(1.5);
    expect(kvSet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(kvSet).toHaveBeenCalledTimes(1);
    expect(kvSet).toHaveBeenCalledWith(ZOOM_KV_KEY, '1.5');
  });
});

describe('loadPersistedZoom', () => {
  it('parses + clamps a stored value', async () => {
    kvGet.mockResolvedValue('1.75');
    await loadPersistedZoom();
    expect(getZoom()).toBe(1.75);
    expect(setZoomFactor).toHaveBeenCalledWith(1.75);
  });

  it('falls back to default on null', async () => {
    kvGet.mockResolvedValue(null);
    await loadPersistedZoom();
    expect(getZoom()).toBe(ZOOM_DEFAULT);
  });

  it('falls back to default when KV throws', async () => {
    kvGet.mockRejectedValue(new Error('kv down'));
    await loadPersistedZoom();
    expect(getZoom()).toBe(ZOOM_DEFAULT);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/lib/zoom.test.ts`
Expected: FAIL — `Failed to resolve import './zoom'` (module doesn't exist yet).

- [ ] **Step 3: Write the controller**

Create `src/renderer/lib/zoom.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/lib/zoom.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint**

Run: `npx eslint src/renderer/lib/zoom.ts src/renderer/lib/zoom.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/lib/zoom.ts src/renderer/lib/zoom.test.ts
git commit -m "feat(zoom): zoom controller — clamp/step/persist/load + HUD emitter"
```

---

## Task 3: Shared wheel predicate (TDD)

**Files:**
- Create: `src/renderer/lib/wheel-zoom.ts`
- Test: `src/renderer/lib/wheel-zoom.test.ts`

Extracting the "is this a zoom gesture?" rule into one pure function lets both the xterm escape hatch (Task 5) and the Constellation guard (Task 8) share it and be tested.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/lib/wheel-zoom.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isZoomWheel, ctrlWheelShouldBubble } from './wheel-zoom';

describe('isZoomWheel', () => {
  it('is true when ctrl or meta is held', () => {
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true);
  });
  it('is false for a plain wheel', () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('ctrlWheelShouldBubble', () => {
  it('returns false for a zoom wheel (suppress local scroll, let it bubble)', () => {
    expect(ctrlWheelShouldBubble({ ctrlKey: true, metaKey: false })).toBe(false);
  });
  it('returns true for a plain wheel (local scroll proceeds)', () => {
    expect(ctrlWheelShouldBubble({ ctrlKey: false, metaKey: false })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/lib/wheel-zoom.test.ts`
Expected: FAIL — cannot resolve `./wheel-zoom`.

- [ ] **Step 3: Write the predicate**

Create `src/renderer/lib/wheel-zoom.ts`:

```ts
// The single rule for "this wheel event is a zoom gesture". Shared by the
// xterm custom-wheel handler and the Constellation canvas guard so both agree
// on the gesture and the rule is unit-tested in one place.

export type WheelMods = Pick<WheelEvent, 'ctrlKey' | 'metaKey'>;

/** True when Ctrl (Win/Linux) or Cmd (macOS) is held during a wheel. */
export function isZoomWheel(e: WheelMods): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * xterm's `attachCustomWheelEventHandler` contract: return `false` to suppress
 * xterm's own scrollback handling for this event (it still bubbles to the
 * window-level zoom listener), `true` to let xterm scroll normally.
 */
export function ctrlWheelShouldBubble(e: WheelMods): boolean {
  return !isZoomWheel(e);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/lib/wheel-zoom.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/renderer/lib/wheel-zoom.ts src/renderer/lib/wheel-zoom.test.ts
git add src/renderer/lib/wheel-zoom.ts src/renderer/lib/wheel-zoom.test.ts
git commit -m "feat(zoom): shared ctrl-wheel zoom-gesture predicate"
```

---

## Task 4: `useZoomControls` hook (TDD)

**Files:**
- Create: `src/renderer/app/useZoomControls.ts`
- Test: `src/renderer/app/useZoomControls.test.tsx`

The hook owns the side-effect orchestration: on a zoom gesture it applies, persists, and notifies the HUD. It mounts a `window` `wheel` listener (`{ passive: false }` so `preventDefault` suppresses Chromium's native zoom) and keyboard bindings via `bindShortcut`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/useZoomControls.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const applyZoom = vi.fn((f: number) => f);
const zoomByWheel = vi.fn((d: number) => (d < 0 ? 1.1 : 0.9));
const zoomIn = vi.fn(() => 1.1);
const zoomOut = vi.fn(() => 0.9);
const resetZoom = vi.fn(() => 1.0);
const persistZoom = vi.fn();
const notifyZoom = vi.fn();

vi.mock('@/renderer/lib/zoom', () => ({
  zoomByWheel: (d: number) => zoomByWheel(d),
  zoomIn: () => zoomIn(),
  zoomOut: () => zoomOut(),
  resetZoom: () => resetZoom(),
  persistZoom: (f: number) => persistZoom(f),
  notifyZoom: (f: number) => notifyZoom(f),
  applyZoom: (f: number) => applyZoom(f),
}));

import { useZoomControls } from './useZoomControls';

function Harness() {
  useZoomControls();
  return null;
}

function wheel(opts: { ctrlKey?: boolean; metaKey?: boolean; deltaY: number }): WheelEvent {
  const e = new Event('wheel', { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperty(e, 'ctrlKey', { value: opts.ctrlKey ?? false });
  Object.defineProperty(e, 'metaKey', { value: opts.metaKey ?? false });
  Object.defineProperty(e, 'deltaY', { value: opts.deltaY });
  return e;
}

beforeEach(() => {
  [applyZoom, zoomByWheel, zoomIn, zoomOut, resetZoom, persistZoom, notifyZoom].forEach((m) =>
    m.mockClear(),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useZoomControls', () => {
  it('zooms + prevents default on a ctrl/meta wheel, and persists + notifies', () => {
    render(<Harness />);
    const e = wheel({ ctrlKey: true, deltaY: -120 });
    const prevented = vi.spyOn(e, 'preventDefault');
    window.dispatchEvent(e);
    expect(zoomByWheel).toHaveBeenCalledWith(-120);
    expect(prevented).toHaveBeenCalled();
    expect(persistZoom).toHaveBeenCalled();
    expect(notifyZoom).toHaveBeenCalled();
  });

  it('ignores a plain wheel (no modifier)', () => {
    render(<Harness />);
    const e = wheel({ deltaY: -120 });
    const prevented = vi.spyOn(e, 'preventDefault');
    window.dispatchEvent(e);
    expect(zoomByWheel).not.toHaveBeenCalled();
    expect(prevented).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+0 resets zoom', () => {
    render(<Harness />);
    const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
    const e = new KeyboardEvent('keydown', {
      key: '0',
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    expect(resetZoom).toHaveBeenCalled();
  });

  it('removes listeners on unmount', () => {
    const { unmount } = render(<Harness />);
    unmount();
    const e = wheel({ ctrlKey: true, deltaY: -120 });
    window.dispatchEvent(e);
    expect(zoomByWheel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/app/useZoomControls.test.tsx`
Expected: FAIL — cannot resolve `./useZoomControls`.

- [ ] **Step 3: Write the hook**

Create `src/renderer/app/useZoomControls.ts`:

```ts
// Root-mounted hook that wires the whole-app zoom gestures. Owns side-effect
// orchestration (apply → persist → notify HUD); the math/state lives in
// lib/zoom.ts. Mounted once in App (never unmounts).

import { useEffect } from 'react';
import { bindShortcut } from '@/renderer/lib/shortcuts';
import { isZoomWheel } from '@/renderer/lib/wheel-zoom';
import { notifyZoom, persistZoom, resetZoom, zoomByWheel, zoomIn, zoomOut } from '@/renderer/lib/zoom';

export function useZoomControls(): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!isZoomWheel(e)) return;
      // passive:false listener — suppress Chromium's native ctrl+wheel zoom so
      // we own the step, HUD, and persistence.
      e.preventDefault();
      const f = zoomByWheel(e.deltaY);
      persistZoom(f);
      notifyZoom(f);
    };
    window.addEventListener('wheel', onWheel, { passive: false });

    const after = (f: number) => {
      persistZoom(f);
      notifyZoom(f);
    };
    const unbinders = [
      bindShortcut('mod+=', (e) => {
        e.preventDefault();
        after(zoomIn());
      }),
      bindShortcut('mod+-', (e) => {
        e.preventDefault();
        after(zoomOut());
      }),
      bindShortcut('mod+0', (e) => {
        e.preventDefault();
        after(resetZoom());
      }),
    ];

    return () => {
      window.removeEventListener('wheel', onWheel);
      for (const off of unbinders) off();
    };
  }, []);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/app/useZoomControls.test.tsx`
Expected: PASS.

> Note: `bindShortcut('mod+=', …)` matches Ctrl/Cmd+`=` (unshifted). Heavy zooming uses the wheel; shifted `+` is intentionally not bound (the `bindShortcut` spec parser splits on `+`).

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/renderer/app/useZoomControls.ts src/renderer/app/useZoomControls.test.tsx
git add src/renderer/app/useZoomControls.ts src/renderer/app/useZoomControls.test.tsx
git commit -m "feat(zoom): useZoomControls hook — wheel + keyboard gestures"
```

---

## Task 5: xterm escape hatch

**Files:**
- Modify: `src/renderer/lib/terminal-cache.ts:296` (just after `term.open(parking);`)

So Ctrl/Cmd+scroll over a terminal suppresses xterm scrollback and bubbles to the window zoom listener. Covered behaviorally by `wheel-zoom.test.ts` (the predicate); the one-line wiring is verified by the type build.

- [ ] **Step 1: Import the predicate**

Add to the imports at the top of `src/renderer/lib/terminal-cache.ts` (near the other `./` imports):

```ts
import { ctrlWheelShouldBubble } from './wheel-zoom';
```

- [ ] **Step 2: Attach the custom wheel handler on cache-miss**

In `getOrCreateTerminal`, immediately after `term.open(parking);` (line 296), add:

```ts
  // Ctrl/Cmd+wheel is a whole-app zoom gesture, not terminal scrollback.
  // Returning false suppresses xterm's own scroll for those events; the event
  // still bubbles to the window-level zoom listener (useZoomControls).
  term.attachCustomWheelEventHandler(ctrlWheelShouldBubble);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: PASS. (`attachCustomWheelEventHandler` exists on xterm 6's `Terminal`.)

- [ ] **Step 4: Re-run the predicate test (unchanged, sanity)**

Run: `npx vitest run src/renderer/lib/wheel-zoom.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/terminal-cache.ts
git commit -m "feat(zoom): bubble ctrl+wheel out of xterm to the zoom handler"
```

---

## Task 6: Zoom HUD (TDD)

**Files:**
- Create: `src/renderer/app/ZoomIndicator.tsx`
- Test: `src/renderer/app/ZoomIndicator.test.tsx`

A transient pill that shows the current percent on each zoom change and fades after ~1s.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/ZoomIndicator.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { ZoomIndicator } from './ZoomIndicator';
import { notifyZoom } from '@/renderer/lib/zoom';

// Use the REAL emitter from lib/zoom (subscribeZoom/notifyZoom are pure JS,
// no DOM/bridge needed). Mock rpc so importing zoom.ts doesn't hit a real client.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: vi.fn() } },
  rpcSilent: { kv: { set: vi.fn() } },
}));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ZoomIndicator', () => {
  it('is hidden until a zoom event, then shows the percent', () => {
    const { container } = render(<ZoomIndicator />);
    expect(container.textContent).toBe('');
    act(() => {
      notifyZoom(1.2);
    });
    expect(container.textContent).toContain('120%');
  });

  it('hides again ~1s after the last zoom event', () => {
    const { container } = render(<ZoomIndicator />);
    act(() => {
      notifyZoom(1.5);
    });
    expect(container.textContent).toContain('150%');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/app/ZoomIndicator.test.tsx`
Expected: FAIL — cannot resolve `./ZoomIndicator`.

- [ ] **Step 3: Write the component**

Create `src/renderer/app/ZoomIndicator.tsx`:

```tsx
// Transient zoom-level HUD. Subscribes to the zoom emitter; shows the current
// percent on each change and fades out ~1s after the last one. pointer-events
// off so it never intercepts input. Rendered once at the app root.

import { useEffect, useRef, useState } from 'react';
import { subscribeZoom } from '@/renderer/lib/zoom';

const HIDE_DELAY_MS = 1000;

export function ZoomIndicator() {
  const [percent, setPercent] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribeZoom((pct) => {
      setPercent(pct);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setPercent(null), HIDE_DELAY_MS);
    });
    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (percent == null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-6 z-[9999] -translate-x-1/2 rounded-full border border-border/60 bg-card/90 px-3 py-1 text-sm font-medium tabular-nums text-foreground shadow-lg backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none"
    >
      {percent}%
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/app/ZoomIndicator.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/renderer/app/ZoomIndicator.tsx src/renderer/app/ZoomIndicator.test.tsx
git add src/renderer/app/ZoomIndicator.tsx src/renderer/app/ZoomIndicator.test.tsx
git commit -m "feat(zoom): transient zoom-level HUD pill"
```

---

## Task 7: Wire hook + HUD into App

**Files:**
- Modify: `src/renderer/app/App.tsx` (imports, the `App()` body at line 284, and near `<Toaster />` at line 355)

- [ ] **Step 1: Add imports**

Near the other imports in `src/renderer/app/App.tsx`, add:

```ts
import { useZoomControls } from './useZoomControls';
import { ZoomIndicator } from './ZoomIndicator';
```

- [ ] **Step 2: Call the hook in the App body**

In `export default function App() {`, directly after the existing prefetch effect (`useEffect(() => prefetchRooms(), []);` at line 288), add:

```ts
  // Whole-app zoom: Ctrl/Cmd+wheel and Cmd/Ctrl + =/-/0. Mounted once at root.
  useZoomControls();
```

- [ ] **Step 3: Mount the HUD next to the Toaster**

In the same file, immediately after `<Toaster position="bottom-right" closeButton />` (line 355) and before `</ThemeProvider>`, add:

```tsx
        {/* Transient zoom-level HUD. Outside the error boundary (like Toaster)
            so it surfaces regardless of shell state; pointer-events off. */}
        <ZoomIndicator />
```

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc -b && npx eslint src/renderer/app/App.tsx`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/App.tsx
git commit -m "feat(zoom): mount zoom controls + HUD at app root"
```

---

## Task 8: Boot restore + `app.fontSize` cold-boot bugfix (TDD)

**Files:**
- Modify: `src/renderer/lib/themes.ts:168-173` (`KV_KEYS`)
- Modify: `src/renderer/app/ThemeProvider.tsx:9-11` (imports), `:46-49` (hydrate `Promise.all`), and the apply block after density
- Test: `src/renderer/app/ThemeProvider.zoom.test.tsx`

- [ ] **Step 1: Add KV keys**

In `src/renderer/lib/themes.ts`, change `KV_KEYS` (lines 168-173) to add two entries:

```ts
export const KV_KEYS = {
  theme: 'app.theme',
  onboarded: 'app.onboarded',
  sidebarCollapsed: 'app.sidebar.collapsed',
  density: 'app.density',
  fontSize: 'app.fontSize',
  zoomFactor: 'app.zoomFactor',
} as const;
```

- [ ] **Step 2: Write the failing test**

Create `src/renderer/app/ThemeProvider.zoom.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const kvGet = vi.fn<(k: string) => Promise<string | null>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: (k: string) => kvGet(k), set: vi.fn(() => Promise.resolve()) } },
  rpcSilent: { kv: { set: vi.fn(() => Promise.resolve()) } },
}));

import { ThemeProvider } from './ThemeProvider';

const setZoomFactor = vi.fn();

beforeEach(() => {
  kvGet.mockReset();
  setZoomFactor.mockClear();
  (window as unknown as { sigma: { setZoomFactor: typeof setZoomFactor; getZoomFactor: () => number } }).sigma = {
    setZoomFactor,
    getZoomFactor: () => 1,
  };
  document.documentElement.style.fontSize = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThemeProvider boot restore', () => {
  it('restores persisted fontSize and zoom on mount', async () => {
    kvGet.mockImplementation((k) => {
      if (k === 'app.fontSize') return Promise.resolve('16');
      if (k === 'app.zoomFactor') return Promise.resolve('1.5');
      return Promise.resolve(null);
    });

    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe('16px');
      expect(setZoomFactor).toHaveBeenCalledWith(1.5);
    });
  });

  it('falls back to default zoom (100%) when nothing is stored', async () => {
    kvGet.mockResolvedValue(null);
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(setZoomFactor).toHaveBeenCalledWith(1);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/renderer/app/ThemeProvider.zoom.test.tsx`
Expected: FAIL — `app.fontSize`/`app.zoomFactor` are not read or applied on boot yet (no `setZoomFactor` call; fontSize stays `''`).

- [ ] **Step 4: Wire boot restore in ThemeProvider**

In `src/renderer/app/ThemeProvider.tsx`:

(a) Extend the themes import block (lines 9-11 import `applyDensity`, `applyTheme`, …) to also pull `applyFontSize`:

```ts
  applyDensity,
  applyFontSize,
  applyTheme,
```

(b) Add a zoom import near the top of the file (with the other `@/renderer/lib` imports):

```ts
import { ZOOM_DEFAULT, applyZoom } from '@/renderer/lib/zoom';
```

(c) Replace the hydrate `Promise.all` (lines 46-49) to also fetch the two keys:

```ts
        const [storedTheme, storedDensity, storedFont, storedZoom] = await Promise.all([
          rpc.kv.get(KV_KEYS.theme),
          rpc.kv.get(KV_KEYS.density).catch(() => null),
          rpc.kv.get(KV_KEYS.fontSize).catch(() => null),
          rpc.kv.get(KV_KEYS.zoomFactor).catch(() => null),
        ]);
```

(d) After the density apply block (after line 69, before the closing of the `try`), add:

```ts
        // BUGFIX — app.fontSize was only re-applied when the Settings tab
        // mounted, so the persisted base font size silently reset to default on
        // every cold boot. Restore it here alongside theme/density.
        if (storedFont != null) {
          const n = Number(storedFont);
          if (Number.isFinite(n)) applyFontSize(n);
        }
        // Restore persisted whole-app zoom (silent — no HUD on boot).
        applyZoom(storedZoom == null ? ZOOM_DEFAULT : Number(storedZoom));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/renderer/app/ThemeProvider.zoom.test.tsx`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
npx eslint src/renderer/lib/themes.ts src/renderer/app/ThemeProvider.tsx src/renderer/app/ThemeProvider.zoom.test.tsx
git add src/renderer/lib/themes.ts src/renderer/app/ThemeProvider.tsx src/renderer/app/ThemeProvider.zoom.test.tsx
git commit -m "feat(zoom): cold-boot restore for zoom + fix app.fontSize restore"
```

---

## Task 9: Constellation ctrl-guard

**Files:**
- Modify: `src/renderer/features/operator-console/Constellation.tsx:663-682` (the `onWheel` callback) + imports

So Ctrl/Cmd+scroll over the operator-console canvas does font zoom (bubbles to the window handler) instead of canvas viewport zoom.

- [ ] **Step 1: Import the predicate**

Add to the imports at the top of `Constellation.tsx`:

```ts
import { isZoomWheel } from '@/renderer/lib/wheel-zoom';
```

- [ ] **Step 2: Guard the wheel handler**

In the `onWheel` callback (line 664), add a guard as the FIRST statement, before `e.preventDefault()`:

```ts
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      // Ctrl/Cmd+wheel is whole-app font zoom — let it bubble to the window
      // handler instead of zooming the constellation viewport.
      if (isZoomWheel(e)) return;
      e.preventDefault();
```

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc -b && npx eslint src/renderer/features/operator-console/Constellation.tsx`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/features/operator-console/Constellation.tsx
git commit -m "feat(zoom): let ctrl+wheel over the constellation do font zoom"
```

---

## Task 10: Full gate + roadmap

**Files:**
- Modify: `ROADMAP.md` (record the shipped feature — coordinate with concurrent edits; append only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS (all files green, including the 5 new test files).

> If an unrelated file times out under load, re-run THAT file in isolation (`npx vitest run <path>`) before treating it as a real failure — full-suite timeouts are known flakes in this repo.

- [ ] **Step 2: Lint the whole repo**

Run: `npx eslint .`
Expected: clean.

- [ ] **Step 3: Production build (the real typecheck + bundle)**

Run: `npm run build`
Expected: PASS (`tsc -b` then `vite build`). This is the authoritative type gate (laxer worktree tsc can miss test-file types).

- [ ] **Step 4: Manual smoke (operator, optional — NOT local automated e2e)**

E2e is deferred to the CI e2e-matrix per project convention (no local live-app e2e — it steals focus). If the operator wants a manual check: launch the isolated dev build, Ctrl/Cmd+scroll over a terminal and over the chat → both scale together, HUD shows `%`; Cmd/Ctrl+0 resets; restart → zoom + font size persist.

- [ ] **Step 5: Record in ROADMAP and commit**

Append a one-line shipped entry to `ROADMAP.md` (append-only to avoid stomping the concurrent session's edits), then:

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): ctrl+scroll whole-app zoom shipped"
```

---

## Self-Review

**Spec coverage:**
- Whole-app native zoom (`webFrame.setZoomFactor`) → Tasks 1, 2.
- Ctrl/Cmd+scroll + keyboard `=`/`-`/`0` → Task 4.
- Range 50–200% / clamp → Task 2 (`clampZoom`).
- Brief `%` HUD, ~1s fade → Tasks 2 (emitter), 6 (component), 7 (mount).
- Persist `app.zoomFactor` + cold-boot restore → Tasks 2 (`persistZoom`/`loadPersistedZoom`), 8 (ThemeProvider).
- Bundled `app.fontSize` cold-boot fix → Task 8.
- xterm escape hatch → Tasks 3 (predicate), 5 (wiring).
- Constellation ctrl-guard → Task 9.
- Tests (controller, hook, HUD, predicate, boot) + deferred e2e → Tasks 2, 3, 4, 6, 8, 10.
- Scope boundary (Browser room WebContentsView unaffected) → inherent (separate webContents; no task needed).

**Placeholder scan:** none — every code step shows complete code; every command shows expected output.

**Type consistency:** `applyZoom`, `clampZoom`, `zoomByWheel`, `zoomIn`, `zoomOut`, `resetZoom`, `persistZoom`, `loadPersistedZoom`, `subscribeZoom`, `notifyZoom`, `ZOOM_DEFAULT`, `ZOOM_KV_KEY` defined in Task 2 and consumed identically in Tasks 4, 6, 8. `isZoomWheel`/`ctrlWheelShouldBubble` defined in Task 3, consumed in Tasks 4, 5, 9. `KV_KEYS.fontSize`/`.zoomFactor` defined in Task 8 Step 1, consumed in Task 8 Step 4. `window.sigma.setZoomFactor` defined in Task 1, consumed by Task 2's `zoomBridge()`.
