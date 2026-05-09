// Appearance settings: theme picker (4 themes) + font sizing controls. The
// terminal font is mirrored into a CSS variable on document.documentElement
// so the xterm renderer can read it on the next resize tick.

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { applyFontSize, setRootCssVar, THEMES, type ThemeId } from '@/renderer/lib/themes';
import { useTheme } from '@/renderer/app/ThemeProvider';
import { cn } from '@/lib/utils';

const FONT_SIZES = [12, 13, 14, 16] as const;
const TERMINAL_FONTS = [
  'Consolas, Monaco, Courier New, monospace',
  'JetBrains Mono, Consolas, monospace',
  'Cascadia Code, Consolas, monospace',
  'IBM Plex Mono, Consolas, monospace',
] as const;

const KV_FONT_SIZE = 'app.fontSize';
const KV_TERMINAL_FONT = 'app.terminalFont';

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const [fontSize, setFontSize] = useState<number>(14);
  const [terminalFont, setTerminalFont] = useState<string>(TERMINAL_FONTS[0]);

  useEffect(() => {
    void (async () => {
      const [fs, tf] = await Promise.all([
        rpc.kv.get(KV_FONT_SIZE).catch(() => null),
        rpc.kv.get(KV_TERMINAL_FONT).catch(() => null),
      ]);
      if (fs && !Number.isNaN(Number(fs))) {
        const n = Number(fs);
        setFontSize(n);
        applyFontSize(n);
      }
      if (tf) {
        setTerminalFont(tf);
        setRootCssVar('--terminal-font', tf);
      }
    })();
  }, []);

  function changeFontSize(n: number): void {
    setFontSize(n);
    applyFontSize(n);
    void rpc.kv.set(KV_FONT_SIZE, String(n)).catch(() => undefined);
  }

  function changeTerminalFont(v: string): void {
    setTerminalFont(v);
    setRootCssVar('--terminal-font', v);
    void rpc.kv.set(KV_TERMINAL_FONT, v).catch(() => undefined);
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Theme
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEMES.map((t) => {
            const selected = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id as ThemeId)}
                className={cn(
                  'flex items-center gap-3 rounded-md border px-3 py-2 text-left transition',
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card/40 hover:bg-card',
                )}
              >
                <ThemeSwatch
                  bg={t.swatch.bg}
                  fg={t.swatch.fg}
                  primary={t.swatch.primary}
                  accent={t.swatch.accent}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{t.description}</div>
                </div>
                {selected ? <Check className="h-4 w-4 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Font size
        </div>
        <div className="flex gap-2">
          {FONT_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => changeFontSize(n)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm transition',
                fontSize === n
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card/40 hover:bg-card',
              )}
            >
              {n}px
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Terminal font
        </div>
        <select
          value={terminalFont}
          onChange={(e) => changeTerminalFont(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          {TERMINAL_FONTS.map((f) => (
            <option key={f} value={f}>
              {f.split(',')[0]}
            </option>
          ))}
        </select>
        <div className="mt-2 rounded-md border border-border bg-card/30 p-3 text-xs">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Preview</div>
          <pre className="whitespace-pre" style={{ fontFamily: terminalFont }}>
{`$ sigma launch --workspace ./repo
[ok] 4 panes attached`}
          </pre>
        </div>
      </section>
    </div>
  );
}

function ThemeSwatch({
  bg,
  fg,
  primary,
  accent,
}: {
  bg: string;
  fg: string;
  primary: string;
  accent: string;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-border" style={{ background: bg }}>
      <div className="h-9 w-2.5" style={{ background: fg }} />
      <div className="h-9 w-2.5" style={{ background: primary }} />
      <div className="h-9 w-2.5" style={{ background: accent }} />
      <div className="h-9 w-2.5" style={{ background: bg }} />
    </div>
  );
}
