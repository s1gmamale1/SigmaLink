import { AlertTriangle } from 'lucide-react';
import { rel } from './rel-time';
import type { InterruptedTurn } from './use-sigma-resume-flow';

interface Props {
  turn: InterruptedTurn;
  onRetry: (prompt: string) => void;
  onDismiss: (messageId: string) => void;
}

export function InterruptedTurnBanner({ turn, onRetry, onDismiss }: Props) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
      data-testid="sigma-interrupted-banner"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Interrupted turn from {rel(turn.startedAt)}
      </span>
      <button
        type="button"
        className="rounded border border-amber-500/30 bg-background/60 px-2 py-0.5 font-medium transition hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!turn.previousPrompt}
        onClick={() => {
          if (!turn.previousPrompt) return;
          onDismiss(turn.messageId);
          onRetry(turn.previousPrompt);
        }}
      >
        Retry
      </button>
      <button
        type="button"
        className="rounded px-2 py-0.5 font-medium transition hover:bg-amber-500/15"
        onClick={() => onDismiss(turn.messageId)}
      >
        Dismiss
      </button>
    </div>
  );
}
