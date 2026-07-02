// Tiny presentational <kbd> chip — shared by the launcher landing rows and
// the landing footer hints. Token-only styling.
import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
