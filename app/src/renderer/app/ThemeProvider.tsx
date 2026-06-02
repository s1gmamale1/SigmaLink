// ThemeProvider — pulls the persisted `app.theme` value from the kv table on
// mount, applies it to <html data-theme="...">, and exposes a setter that
// writes through to kv. Wrapped around <App> so every room sees the variable
// changes immediately when the user picks a new theme.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import {
  applyDensity,
  applyTheme,
  DEFAULT_DENSITY,
  DEFAULT_THEME,
  isDensityId,
  isThemeId,
  KV_KEYS,
  type DensityId,
  type ThemeId,
} from '@/renderer/lib/themes';

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
    applyTheme(DEFAULT_THEME);
    applyDensity(DEFAULT_DENSITY);
  }, []);

  // Hydrate from kv.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [storedTheme, storedDensity] = await Promise.all([
          rpc.kv.get(KV_KEYS.theme),
          rpc.kv.get(KV_KEYS.density).catch(() => null),
        ]);
        if (!alive) return;
        // BUG-W7-003: validate the stored value. If it's missing OR not in the
        // canonical theme set, fall back to obsidian and write the corrected
        // value back to kv so the next boot is clean.
        if (isThemeId(storedTheme)) {
          setThemeState(storedTheme);
          applyTheme(storedTheme);
        } else {
          setThemeState(DEFAULT_THEME);
          applyTheme(DEFAULT_THEME);
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
    applyTheme(next);
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
