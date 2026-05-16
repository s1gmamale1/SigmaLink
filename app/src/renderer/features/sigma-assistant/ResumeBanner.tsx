import { RotateCcw, X } from 'lucide-react';
import { rel } from './rel-time';

interface Props {
  lastMessageAt: number;
  onDismiss: () => void;
}

export function ResumeBanner({ lastMessageAt, onDismiss }: Props) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-1.5 text-[11px] text-primary"
      data-testid="sigma-resume-banner"
    >
      <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        Resuming chat from {rel(lastMessageAt)}
      </span>
      <button
        type="button"
        className="ml-auto rounded p-0.5 text-primary/70 transition hover:bg-primary/10 hover:text-primary"
        aria-label="Dismiss resume notice"
        onClick={onDismiss}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
