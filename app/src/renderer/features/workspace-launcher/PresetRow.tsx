// V3-W12-007: preset row beneath the layout tile grid. Renders the most
// recent saved layouts followed by a `+ NEW` chip. Persisted via kv key
// `workspace.recentLayouts` as a JSON array of `{ name, preset }`. Clicking
// `+ NEW` is a no-op stub today (saving named presets is W13/14 work) — we
// emit a callback so the parent can wire it later.

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GridPreset } from '@/shared/types';

export interface SavedLayout {
  name: string;
  preset: GridPreset;
}

interface PresetRowProps {
  layouts: SavedLayout[];
  activePreset: GridPreset;
  onSelect: (preset: GridPreset) => void;
  onCreateNew: () => void;
}

export function PresetRow({
  layouts,
  activePreset,
  onSelect,
  onCreateNew,
}: PresetRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {layouts.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          No saved layouts yet — pick a tile above and save one.
        </span>
      ) : null}
      {layouts.map((l) => {
        const active = l.preset === activePreset;
        return (
          <button
            key={`${l.name}-${l.preset}`}
            type="button"
            onClick={() => onSelect(l.preset)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition',
              active
                ? 'border-ring bg-accent/15 text-foreground'
                : 'border-border bg-card/40 text-muted-foreground hover:bg-card',
            )}
          >
            {l.name}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onCreateNew}
        className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground transition hover:border-ring/40 hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> NEW
      </button>
    </div>
  );
}
