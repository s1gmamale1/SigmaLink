// BSP-T3 — Theme gallery: All/Dark/Light filter + search + responsive grid.
//
// Apple-design-foundations guidance applied:
//   - Segmented filter: `aria-pressed` buttons with ring-based selection (no glow)
//   - Search field: `role=searchbox`, minimal border, semantic tokens
//   - Grid: 8pt gaps, 1→2→3 columns at sm→lg breakpoints
//   - Restraint: filter chrome is quiet; the cards carry the visual weight

import { useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { THEMES, type ThemeId } from '@/renderer/lib/themes';
import { ThemePreviewCard } from './ThemePreviewCard';

type AppearanceFilter = 'all' | 'dark' | 'light';

const FILTER_OPTIONS: ReadonlyArray<{ value: AppearanceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

interface ThemeGalleryProps {
  current: ThemeId;
  onSelect: (id: ThemeId) => void;
}

export function ThemeGallery({ current, onSelect }: ThemeGalleryProps) {
  const [filter, setFilter] = useState<AppearanceFilter>('all');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();

  const visible = THEMES.filter((t) => {
    const matchesFilter = filter === 'all' || t.appearance === filter;
    const matchesSearch =
      !q ||
      t.label.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Filter + search row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Segmented appearance filter */}
        <div
          role="group"
          aria-label="Filter themes by appearance"
          className="inline-flex rounded-md border border-border bg-card/40 p-0.5"
        >
          {FILTER_OPTIONS.map(({ value, label }) => {
            const active = filter === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded px-3 py-1 text-[12px] font-medium transition-[background-color,color,box-shadow] duration-150 ease-smooth',
                  active
                    ? 'bg-accent/15 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--ring))]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[140px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            role="searchbox"
            placeholder="Search themes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-border bg-card/40 py-1.5 pl-8 pr-3 text-[12px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Search themes"
          />
        </div>
      </div>

      {/* Grid of theme cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((t) => (
          <ThemePreviewCard
            key={t.id}
            theme={t}
            active={t.id === current}
            onSelect={onSelect}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-muted-foreground">
          No themes match your search.
        </p>
      ) : null}
    </div>
  );
}
