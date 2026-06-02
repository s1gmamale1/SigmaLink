// V3-W12-007 Step 2: tile grid 1/2/4/6/8/10/12 panes. Each tile shows the
// pane count and previews the grid in miniature. Hover tooltip reads
// `<N> terminals · <RxC> grid` per the V3 frame log (frames 0030/0035/0040).
// PresetRow lives below the tiles and lists recent saved layouts.
//
// FEAT-10 — named launch presets. Saved layouts now persist the per-provider
// counts alongside the pane preset (`{ name, preset, counts? }`). Restoring a
// chip rehydrates BOTH preset + counts; saving a new one captures the current
// selection. `counts` is optional so pre-FEAT-10 `{ name, preset }` entries
// still parse and restore the preset alone.

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import type { GridPreset } from '@/shared/types';
import { PresetRow, type SavedLayout } from './PresetRow';
import { GRID_DIMS, PRESETS, gridLabel } from './grid';

/** kv key for the persisted recent layouts list (kept GLOBAL to match the
 *  pre-existing read; see Launcher KV conventions). Exported for test reuse. */
export const RECENT_LAYOUTS_KV_KEY = 'workspace.recentLayouts';

const MAX_SAVED_LAYOUTS = 6;

interface LayoutStepProps {
  preset: GridPreset;
  onChange: (preset: GridPreset) => void;
  /**
   * FEAT-10 — current per-provider counts (owned by the Launcher). Captured
   * verbatim when the operator saves a new named layout.
   */
  counts: Record<string, number>;
  /**
   * FEAT-10 — restore a saved layout. The Launcher applies the preset and,
   * when present, the persisted counts (clamped to the preset budget).
   */
  onRestoreLayout: (layout: SavedLayout) => void;
}

/** Parse + validate one persisted entry. Returns null for malformed rows.
 *  Exported (test-only) so the backward-compat contract stays pinned. */
// eslint-disable-next-line react-refresh/only-export-components
export function parseSavedLayout(item: unknown): SavedLayout | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : null;
  const presetRaw = typeof obj.preset === 'number' ? (obj.preset as GridPreset) : null;
  if (!name || !presetRaw || !PRESETS.includes(presetRaw as GridPreset)) return null;
  // FEAT-10 — counts optional; only accept a record of finite positive ints.
  let counts: Record<string, number> | undefined;
  if (obj.counts && typeof obj.counts === 'object' && !Array.isArray(obj.counts)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj.counts as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
    if (Object.keys(out).length > 0) counts = out;
  }
  return counts ? { name, preset: presetRaw as GridPreset, counts } : { name, preset: presetRaw as GridPreset };
}

export function LayoutStep({ preset, onChange, counts, onRestoreLayout }: LayoutStepProps) {
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);

  // Recents persist via kv. Failures degrade silently to an empty list.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await rpc.kv.get(RECENT_LAYOUTS_KV_KEY);
        if (!alive || !raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const validated: SavedLayout[] = [];
        for (const item of parsed) {
          const layout = parseSavedLayout(item);
          if (layout) validated.push(layout);
        }
        setLayouts(validated.slice(0, MAX_SAVED_LAYOUTS));
      } catch {
        // ignore — kv parse failure is non-fatal.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // FEAT-10 — persist a new named layout capturing the current preset + counts.
  // Newest first; de-dupe by name (case-insensitive); cap at MAX_SAVED_LAYOUTS.
  // Best-effort kv write — a failure leaves the in-memory list updated so the
  // chip is usable for this session.
  function saveLayout(name: string): void {
    const hasCounts = Object.keys(counts).length > 0;
    const entry: SavedLayout = hasCounts
      ? { name, preset, counts: { ...counts } }
      : { name, preset };
    setLayouts((prev) => {
      const deduped = prev.filter((l) => l.name.toLowerCase() !== name.toLowerCase());
      const next = [entry, ...deduped].slice(0, MAX_SAVED_LAYOUTS);
      void rpc.kv?.set?.(RECENT_LAYOUTS_KV_KEY, JSON.stringify(next))?.catch(() => undefined);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pane count
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
          {PRESETS.map((n) => {
            const { cols, rows } = GRID_DIMS[n];
            const active = n === preset;
            return (
              <button
                key={n}
                type="button"
                onClick={() => onChange(n)}
                title={gridLabel(n)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-md border p-2 text-sm transition',
                  active
                    ? 'border-ring bg-accent/15'
                    : 'border-border bg-card/40 hover:bg-card',
                )}
              >
                <div
                  className="grid w-full gap-[2px]"
                  style={{
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gridTemplateRows: `repeat(${rows}, 1fr)`,
                    aspectRatio: `${cols} / ${rows}`,
                  }}
                  aria-hidden
                >
                  {Array.from({ length: cols * rows }).map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        'rounded-[2px]',
                        active ? 'bg-accent/60' : 'bg-muted/60',
                      )}
                    />
                  ))}
                </div>
                <span className="text-xs font-medium">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Recent layouts
        </div>
        <PresetRow
          layouts={layouts}
          activePreset={preset}
          onSelect={onRestoreLayout}
          onCreateNew={saveLayout}
        />
      </div>
    </div>
  );
}
