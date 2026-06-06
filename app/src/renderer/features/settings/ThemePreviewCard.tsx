// BSP-T3 — Selectable theme preview card.
//
// Renders a mini mock-UI chrome preview (sidebar strip + pane + accent pill)
// painted from `theme.swatch` hexes via inline style — no real `data-theme`
// subtree (render-cost). Follows the IntentCards.tsx selectable-card idiom:
// `<button aria-pressed>`, `border-ring bg-accent/10` selected,
// `hover:-translate-y-0.5 transition ease-smooth`.
//
// Apple-design-foundations guidance applied:
//   - Semantic card chrome tokens (border-ring, bg-accent/10, bg-card/40)
//   - Swatch hexes only inside the inline-style mini-UI — card chrome stays adaptive
//   - 8pt grid: p-2.5 card padding, gap-2 inner spacing
//   - Restraint: one accent badge; no glow; GPU lift on hover only

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ThemeDefinition, ThemeId } from '@/renderer/lib/themes';

interface ThemePreviewCardProps {
  theme: ThemeDefinition;
  active: boolean;
  onSelect: (id: ThemeId) => void;
}

export function ThemePreviewCard({ theme, active, onSelect }: ThemePreviewCardProps) {
  const { swatch } = theme;

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={theme.label}
      data-testid={`theme-card-${theme.id}`}
      onClick={() => onSelect(theme.id)}
      className={cn(
        'group relative flex flex-col rounded-xl border p-2.5 text-left',
        'transition-[transform,border-color,background-color,box-shadow] duration-200 ease-smooth',
        'hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-ring bg-accent/10 shadow-sm'
          : 'border-border bg-card/40 hover:border-ring/50 hover:bg-card hover:shadow-sm',
      )}
    >
      {/* Mini mock-UI preview — painted from swatch hexes via inline style */}
      <MiniUIPreview swatch={swatch} />

      {/* Theme label + description */}
      <div className="mt-2 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium leading-snug">{theme.label}</span>
          {active ? (
            <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-accent/20 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
              <Check className="h-2.5 w-2.5" aria-hidden />
              Active
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground">
          {theme.description}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mini mock-UI chrome — aspect 16/10, inline-styled from swatch hexes.
// Depicts: sidebar strip (primary/fg) + header bar + pane with text rows +
// one accent-colored "button" pill. Static markup — zero render cost.
// ---------------------------------------------------------------------------
function MiniUIPreview({
  swatch,
}: {
  swatch: { bg: string; fg: string; primary: string; accent: string };
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg"
      style={{ aspectRatio: '16/10', background: swatch.bg }}
      aria-hidden
    >
      {/* Sidebar strip */}
      <div
        className="absolute inset-y-0 left-0 flex flex-col gap-1 px-1 py-2"
        style={{ width: '22%', background: `${swatch.primary}18` }}
      >
        {/* Logo dot */}
        <div
          className="mx-auto mb-1 h-2 w-2 rounded-full"
          style={{ background: swatch.primary }}
        />
        {/* Nav rows */}
        {[0.5, 0.3, 0.3].map((opacity, i) => (
          <div
            key={i}
            className="h-1 rounded-full"
            style={{ background: swatch.fg, opacity, width: i === 0 ? '80%' : '60%' }}
          />
        ))}
      </div>

      {/* Main pane */}
      <div className="absolute inset-y-0 right-0" style={{ left: '22%' }}>
        {/* Header bar */}
        <div
          className="flex items-center gap-1 px-2"
          style={{ height: '22%', background: `${swatch.fg}08`, borderBottom: `1px solid ${swatch.fg}14` }}
        >
          <div className="h-1 w-1 rounded-full" style={{ background: swatch.fg, opacity: 0.4 }} />
          <div className="h-1 flex-1 rounded-full" style={{ background: swatch.fg, opacity: 0.15, maxWidth: '40%' }} />
        </div>

        {/* Content rows */}
        <div className="flex flex-col gap-1 p-2" style={{ paddingTop: '8%' }}>
          {[0.25, 0.18, 0.18].map((opacity, i) => (
            <div
              key={i}
              className="h-1 rounded-full"
              style={{ background: swatch.fg, opacity, width: i === 0 ? '70%' : i === 1 ? '55%' : '40%' }}
            />
          ))}
          {/* Accent pill button */}
          <div
            className="mt-1 rounded-full px-2 py-0.5 text-[0px]"
            style={{
              background: swatch.accent,
              width: '36%',
              height: '14%',
              minHeight: 4,
            }}
          />
        </div>
      </div>
    </div>
  );
}
