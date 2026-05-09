// V3-W12-007 Step 2: tile grid 1/2/4/6/8/10/12 panes. Each tile shows the
// pane count and previews the grid in miniature. Hover tooltip reads
// `<N> terminals · <RxC> grid` per the V3 frame log (frames 0030/0035/0040).
// PresetRow lives below the tiles and lists recent saved layouts.

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import type { GridPreset } from '@/shared/types';
import { PresetRow, type SavedLayout } from './PresetRow';
import { GRID_DIMS, PRESETS, gridLabel } from './grid';

interface LayoutStepProps {
  preset: GridPreset;
  onChange: (preset: GridPreset) => void;
}

export function LayoutStep({ preset, onChange }: LayoutStepProps) {
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);

  // Recents persist via kv. Failures degrade silently to an empty list.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await rpc.kv.get('workspace.recentLayouts');
        if (!alive || !raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const validated: SavedLayout[] = [];
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const obj = item as Record<string, unknown>;
          const name = typeof obj.name === 'string' ? obj.name : null;
          const presetRaw = typeof obj.preset === 'number' ? (obj.preset as GridPreset) : null;
          if (name && presetRaw && PRESETS.includes(presetRaw as GridPreset)) {
            validated.push({ name, preset: presetRaw as GridPreset });
          }
        }
        setLayouts(validated.slice(0, 6));
      } catch {
        // ignore — kv parse failure is non-fatal.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
          onSelect={onChange}
          onCreateNew={() => {
            // Stub — saving a named preset lands in W13/14. We surface a hint
            // via the recents row so the affordance is discoverable today.
          }}
        />
      </div>
    </div>
  );
}
