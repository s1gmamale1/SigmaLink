// Slim error banner used at the top of any room when an `rpc.*` call rejects
// or otherwise produces a user-visible failure. Emits the message + an
// optional retry action, and can be dismissed.

import { AlertTriangle, RefreshCcw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  message: ReactNode;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export function ErrorBanner({ message, onRetry, onDismiss, className }: Props) {
  return (
    <div
      className={cn(
        'sl-slide-up flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive',
        className,
      )}
      role="alert"
    >
      <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</div>
      <div className="flex shrink-0 items-center gap-1">
        {onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
            onClick={onRetry}
          >
            <RefreshCcw className="h-3 w-3" />
            Retry
          </Button>
        ) : null}
        {onDismiss ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-destructive hover:bg-destructive/15 hover:text-destructive"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
