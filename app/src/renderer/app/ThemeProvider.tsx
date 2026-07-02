// ThemeProvider — pulls the persisted `app.theme` value from the kv table on
// mount, applies it to <html data-theme="...">, and exposes a setter that
// writes through to kv. Wrapped around <App> so every room sees the variable
// changes immediately when the user picks a new theme.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import {
  applyDensity,
  applyFontSize,
  applyTheme,
  DEFAULT_DENSITY,
  DEFAULT_THEME,
  findTheme,
  isDensityId,
  isThemeId,
  KV_KEYS,
  type DensityId,
  type ThemeId,
} from '@/renderer/lib/themes';
import { applyTerminalPalette } from '@/renderer/lib/terminal-cache';
import { loadPersistedZoom } from '@/renderer/lib/zoom';

/** Phase 17 — a theme is chrome tokens AND a terminal palette; every apply
 *  site goes through this pair so the two can never drift. `applyTheme` sets
 *  `data-theme` + the dark/light class; `applyTerminalPalette` updates the
 *  shared palette store (DOM presenter) and live-restyles cached xterms. */
function applyThemeAndPalette(id: ThemeId): void {
  applyTheme(id);
  applyTerminalPalette(findTheme(id).terminal);
}

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
  density: DensityId;
  setDensity: (next: DensityId) => void;
  ready: boolean;
}

const Ctx = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [density, setDensityState] = useState<DensityId>(DEFAULT_DENSITY);
  const [ready, setReady] = useState(false);

  // Apply defaults immediately so first paint is themed + at the default density.
  useEffect(() => {
    applyThemeAndPalette(DEFAULT_THEME);
    applyDensity(DEFAULT_DENSITY);
  }, []);

  // Hydrate from kv.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [storedTheme, storedDensity, storedFont] = await Promise.all([
          rpc.kv.get(KV_KEYS.theme),
          rpc.kv.get(KV_KEYS.density).catch(() => null),
          rpc.kv.get(KV_KEYS.fontSize).catch(() => null),
        ]);
        if (!alive) return;
        // BUG-W7-003: validate the stored value. If it's missing OR not in the
        // canonical theme set, fall back to DEFAULT_THEME (glass) and write the
        // corrected value back to kv so the next boot is clean.
        if (isThemeId(storedTheme)) {
          setThemeState(storedTheme);
          applyThemeAndPalette(storedTheme);
        } else {
          setThemeState(DEFAULT_THEME);
          applyThemeAndPalette(DEFAULT_THEME);
          void rpc.kv.set(KV_KEYS.theme, DEFAULT_THEME).catch(() => undefined);
        }
        // P5.2 — same validate-or-fall-back contract for the global density.
        if (isDensityId(storedDensity)) {
          setDensityState(storedDensity);
          applyDensity(storedDensity);
        } else {
          setDensityState(DEFAULT_DENSITY);
          applyDensity(DEFAULT_DENSITY);
        }
        // BUGFIX — app.fontSize was only re-applied when the Settings tab
        // mounted, so the persisted base font size silently reset to default on
        // every cold boot. Restore it here alongside theme/density.
        if (storedFont != null) {
          const n = Number(storedFont);
          if (Number.isFinite(n)) applyFontSize(n);
        }
        // Restore persisted whole-app zoom (silent — no HUD on boot). Delegates
        // to the controller's read-parse-clamp-fallback helper (single source of
        // truth for the zoom-restore contract).
        void loadPersistedZoom();
      } catch {
        // kv may be unavailable during very early app boot; non-fatal.
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // C2 — Window focus/blur → data-window-focused (glass recede-on-blur).
  // Runs once on mount; cleans up both listeners on unmount.
  useEffect(() => {
    document.documentElement.dataset.windowFocused = document.hasFocus() ? 'true' : 'false';
    const onFocus = () => {
      document.documentElement.dataset.windowFocused = 'true';
    };
    const onBlur = () => {
      document.documentElement.dataset.windowFocused = 'false';
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const setTheme = (next: ThemeId) => {
    setThemeState(next);
    applyThemeAndPalette(next);
    void rpc.kv.set(KV_KEYS.theme, next).catch(() => undefined);
  };

  const setDensity = (next: DensityId) => {
    setDensityState(next);
    applyDensity(next);
    void rpc.kv.set(KV_KEYS.density, next).catch(() => undefined);
  };

  return (
    <Ctx.Provider value={{ theme, setTheme, density, setDensity, ready }}>{children}</Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside <ThemeProvider>');
  return v;
}
