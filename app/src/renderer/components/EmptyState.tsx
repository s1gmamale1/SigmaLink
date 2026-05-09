// Generic empty state used across rooms. Title + optional description, an
// optional icon (a Lucide component or any ReactNode), and an optional CTA.
// Intentionally restrained — no illustration, just calm typography that
// matches the dark/light/parchment themes via foreground tokens.

import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon: Icon = Inbox, action, className }: Props) {
  return (
    <div
      className={cn(
        'sl-fade-in flex h-full w-full flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="grid h-10 w-10 place-items-center rounded-full border border-border bg-muted/30">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
      </div>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description ? (
        <div className="max-w-md text-xs text-muted-foreground">{description}</div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
