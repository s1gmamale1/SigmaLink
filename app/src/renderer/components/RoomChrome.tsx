// Shared chrome for every Room. Renders the header strip (icon + title +
// subtitle + right-side actions) and slots a body area below it. Rooms can
// also pass an `errorBanner` (shown above the body) and a `loading` flag
// (shows a Skeleton placeholder in place of `children`).

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Props {
  icon?: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  errorBanner?: ReactNode;
  loading?: boolean;
  loadingHint?: string;
  className?: string;
  children?: ReactNode;
}

export function RoomChrome({
  icon: Icon,
  title,
  subtitle,
  actions,
  errorBanner,
  loading = false,
  loadingHint,
  className,
  children,
}: Props) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/10 px-3 text-sm">
        {Icon ? <Icon className="h-4 w-4 text-primary" aria-hidden /> : null}
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle ? (
          <span className="ml-2 truncate text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
        {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
      </header>
      {errorBanner}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading ? <RoomSkeleton hint={loadingHint} /> : children}
      </div>
    </div>
  );
}

function RoomSkeleton({ hint }: { hint?: string }) {
  return (
    <div className="sl-fade-in flex h-full min-h-0 flex-col gap-3 p-4">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
