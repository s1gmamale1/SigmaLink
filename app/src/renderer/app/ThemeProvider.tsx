// ThemeProvider — pulls the persisted `app.theme` value from the kv table on
// mount, applies it to <html data-theme="...">, and exposes a setter that
// writes through to kv. Wrapped around <App> so every room sees the variable
// changes immediately when the user picks a new theme.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { applyTheme, DEFAULT_THEME, isThemeId, KV_KEYS, type ThemeId } from '@/renderer/lib/themes';

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
  ready: boolean;
}

const Ctx = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [ready, setReady] = useState(false);

  // Apply default immediately so first paint is themed.
  useEffect(() => {
    applyTheme(DEFAULT_THEME);
  }, []);

  // Hydrate from kv.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stored = await rpc.kv.get(KV_KEYS.theme);
        if (!alive) return;
        const next = isThemeId(stored) ? stored : DEFAULT_THEME;
        setThemeState(next);
        applyTheme(next);
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

  const setTheme = (next: ThemeId) => {
    setThemeState(next);
    applyTheme(next);
    void rpc.kv.set(KV_KEYS.theme, next).catch(() => undefined);
  };

  return <Ctx.Provider value={{ theme, setTheme, ready }}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside <ThemeProvider>');
  return v;
}
