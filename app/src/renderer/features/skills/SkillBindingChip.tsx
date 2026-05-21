// v1.7.1 W-5 Skills Phase 2 — Dismissible chip rendered on panes and the
// workspace header to show an INFORMATIONAL skill binding.
//
// SCOPE NOTE: This chip is purely visual. It does NOT affect agent dispatch,
// does NOT inject into agent context, and does NOT alter tool-calling.

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SkillBinding {
  id: string;
  skillName: string;
  skillSource: string;
  paneSessionId: string | null;
}

interface Props {
  binding: SkillBinding;
  onDetach: (bindingId: string) => void;
  /** Additional class names for container customisation. */
  className?: string;
}

const SOURCE_COLOR: Record<string, string> = {
  superpowers: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  ruflo: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
};

export function SkillBindingChip({ binding, onDetach, className }: Props) {
  const colorClass = SOURCE_COLOR[binding.skillSource] ?? 'bg-muted text-muted-foreground border-border';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
        colorClass,
        className,
      )}
      data-testid="skill-binding-chip"
      data-binding-id={binding.id}
      data-skill-name={binding.skillName}
    >
      <span className="truncate max-w-[80px]">{binding.skillName}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDetach(binding.id);
        }}
        className="ml-0.5 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`Detach skill ${binding.skillName}`}
        data-testid="skill-binding-chip-dismiss"
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
    </span>
  );
}
