import { cn } from '@/lib/utils';
import type { SwarmPreset } from '@/shared/types';
import { PRESETS } from './preset-data';

interface Props {
  value: SwarmPreset;
  onChange: (preset: SwarmPreset) => void;
}

export function PresetPicker({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {PRESETS.map((p) => {
        const active = value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition',
              active
                ? 'border-primary bg-primary/15 text-primary-foreground'
                : 'border-border bg-card/40 hover:bg-card',
            )}
          >
            <div className="flex w-full items-center justify-between">
              <div className="text-sm font-medium">{p.label}</div>
              <div className="text-xs text-muted-foreground">{p.total}</div>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {p.split.coordinator}c · {p.split.builder}b · {p.split.scout}s · {p.split.reviewer}r
            </div>
          </button>
        );
      })}
    </div>
  );
}
