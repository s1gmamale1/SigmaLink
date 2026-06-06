// BSP-T4 — "This workspace" tint section inside AppearanceTab.
//
// Rendered ONLY when a workspace is active. Lets the user pick an accent hue
// that persists at `ui.<wsId>.tint` and applies immediately via
// `applyTint` (inline style on <html>). On workspace switch the
// `useWorkspaceTint` hook automatically clears the override — no leak.
//
// Apple-design-foundations guidance:
//   - One tasteful sentence in apple-design-tactics voice (informative, not
//     marketing) explaining the workspace-scoped nature.
//   - Restraint: color picker + 5 preset hue pills + a "Reset to global" button.
//     No glow; no extra decoration. Semantic card chrome.
//   - 8pt grid: p-3 section padding, gap-3 inner spacing.
//
// Security: hex values are validated by `parseTint` before any DOM write.
// The <input type="color"> yields valid hex; preset pills are hardcoded hex.

import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import { cn } from '@/lib/utils';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import { applyTint, clearTint, parseTint } from '@/renderer/lib/workspace-tint';

/** Preset hue pills — all validated hex (3 or 6 digit). */
const PRESETS = [
  { label: 'Violet',   hex: '#a855f7' },
  { label: 'Cyan',     hex: '#22d3ee' },
  { label: 'Rose',     hex: '#f43f5e' },
  { label: 'Emerald',  hex: '#10b981' },
  { label: 'Amber',    hex: '#f59e0b' },
] as const;

/** Neutral seed for the picker when no per-workspace tint is set. A mid-grey
 *  so the custom-color swatch reads as "no tint chosen" (no preset highlighted)
 *  after a reset, rather than leaving the last-picked hue colored in. */
const NEUTRAL_TINT = '#808080';

interface WorkspaceTintSectionProps {
  activeWorkspaceId: string | null;
}

export function WorkspaceTintSection({ activeWorkspaceId }: WorkspaceTintSectionProps) {
  const [current, setCurrent] = useState<string>(NEUTRAL_TINT);

  // Load persisted tint on mount / workspace change
  useEffect(() => {
    if (!activeWorkspaceId) return;
    void readWorkspaceUi(activeWorkspaceId, 'tint').then((raw) => {
      const t = parseTint(raw);
      if (t) setCurrent(t.accent);
    });
  }, [activeWorkspaceId]);

  if (!activeWorkspaceId) return null;

  function handleChange(hex: string) {
    // Validate (type="color" always gives valid hex, but be explicit for security)
    const t = parseTint(JSON.stringify({ accent: hex }));
    if (!t) return;
    setCurrent(t.accent);
    applyTint(t);
    void writeWorkspaceUi(activeWorkspaceId!, 'tint', JSON.stringify({ accent: t.accent }));
  }

  function handleReset() {
    clearTint();
    // Reset the local picker state too, so no preset stays highlighted and the
    // custom swatch reverts to neutral (no stale colored swatch — NIT-5).
    setCurrent(NEUTRAL_TINT);
    void writeWorkspaceUi(activeWorkspaceId!, 'tint', '');
  }

  return (
    <section
      aria-label="Per-workspace accent color"
      className="rounded-xl border border-border bg-card/30 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Palette className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            This workspace
          </span>
        </div>
        <button
          type="button"
          onClick={handleReset}
          aria-label="Reset to global"
          className="rounded border border-border bg-card/40 px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-card hover:text-foreground"
        >
          Reset to global
        </button>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Choose an accent hue for this workspace only — it won't affect your global theme
        or any other workspace.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* Preset hue pills */}
        {PRESETS.map(({ label, hex }) => (
          <button
            key={hex}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => handleChange(hex)}
            className={cn(
              'h-6 w-6 rounded-full border-2 transition-[transform,border-color] duration-150 ease-smooth',
              'hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              current === hex ? 'border-ring scale-110' : 'border-transparent',
            )}
            style={{ background: hex }}
          />
        ))}

        {/* Custom color picker */}
        <label className="relative flex items-center" title="Custom color">
          <input
            type="color"
            aria-label="Workspace tint"
            value={current}
            onChange={(e) => handleChange(e.target.value)}
            className="absolute opacity-0 w-0 h-0"
          />
          {/* Visible swatch that opens the native color picker on click */}
          <div
            className={cn(
              'h-6 w-6 cursor-pointer rounded-full border-2 transition-[transform,border-color] duration-150 ease-smooth',
              'hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !PRESETS.some((p) => p.hex === current) ? 'border-ring scale-110' : 'border-dashed border-border',
            )}
            style={{ background: current }}
            aria-hidden
          />
        </label>
      </div>
    </section>
  );
}
