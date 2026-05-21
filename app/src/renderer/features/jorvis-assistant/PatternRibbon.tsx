import { Sparkles, X } from 'lucide-react';

interface Props {
  pattern: string;
  confidence: number;
  onApply: () => void;
  onDismiss: () => void;
}

export function PatternRibbon({ pattern, confidence, onApply, onDismiss }: Props) {
  return (
    <div className="flex items-start gap-2 border-t border-primary/20 bg-primary/5 px-3 py-2 text-xs">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-primary">
          Similar past task ({Math.round(confidence * 100)}% confidence)
        </div>
        <div className="mt-0.5 line-clamp-2 text-muted-foreground">{pattern}</div>
      </div>
      <button
        type="button"
        className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition hover:bg-primary/20"
        onClick={onApply}
      >
        Apply
      </button>
      <button
        type="button"
        className="rounded p-0.5 text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
        aria-label="Dismiss similar task"
        onClick={onDismiss}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
