// V3-W12-007: preset row beneath the layout tile grid. Renders the most
// recent saved layouts followed by a `+ NEW` chip. Persisted via kv key
// `workspace.recentLayouts` as a JSON array of `{ name, preset, counts? }`.
//
// FEAT-10 — named launch presets: clicking a saved chip restores BOTH the
// pane preset and the per-provider counts (when the layout carries them).
// `+ NEW` is now wired: it opens a small inline name dialog (the parent owns
// the persistence) so the operator can capture the current pane-count +
// provider distribution as a reusable chip.

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GridPreset } from '@/shared/types';

export interface SavedLayout {
  name: string;
  preset: GridPreset;
  /**
   * FEAT-10 — per-provider pane counts captured when the layout was saved.
   * Optional for backward-compat: pre-FEAT-10 entries persisted only
   * `{ name, preset }`, so a missing/undefined `counts` restores the preset
   * alone (the AgentsStep matrix is left as-is).
   */
  counts?: Record<string, number>;
}

interface PresetRowProps {
  layouts: SavedLayout[];
  activePreset: GridPreset;
  /** FEAT-10 — select a saved layout (restores preset + counts when present). */
  onSelect: (layout: SavedLayout) => void;
  /** FEAT-10 — persist a new named layout from the current selection. */
  onCreateNew: (name: string) => void;
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
            onClick={() => onSelect(l)}
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
      <NewPresetChip onCreateNew={onCreateNew} />
    </div>
  );
}

interface NewPresetChipProps {
  onCreateNew: (name: string) => void;
}

// FEAT-10 — the `+ NEW` chip toggles into an inline name field. A calm
// `bg-background` surface (NOT `bg-accent` — see the v1.36 purple-flash
// lesson) keeps the transient input visually quiet. Enter / Save commits a
// trimmed non-empty name; Escape or blur-on-empty cancels.
function NewPresetChip({ onCreateNew }: NewPresetChipProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  function commit() {
    const trimmed = name.trim();
    if (trimmed) onCreateNew(trimmed);
    setName('');
    setEditing(false);
  }

  function cancel() {
    setName('');
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground transition hover:border-ring/40 hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> NEW
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-full border border-ring bg-background px-2 py-0.5">
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
        }}
        placeholder="Layout name"
        aria-label="New layout name"
        className="w-28 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={commit}
        disabled={!name.trim()}
        className="rounded-full px-2 py-0.5 text-xs text-foreground transition hover:bg-card disabled:opacity-40"
      >
        Save
      </button>
    </div>
  );
}
