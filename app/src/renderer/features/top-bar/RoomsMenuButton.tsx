// V3-W12 / SigmaLink v1.1.4 Step 2: replaces the sidebar's 12-row room nav
// with a single grid-icon button at the left edge of the top breadcrumb.
// Clicking opens a Radix DropdownMenu that lists every room the sidebar used
// to expose. Icons + labels are lifted verbatim from `Sidebar.tsx` so the
// visual rhythm stays identical across the port.
//
// The breadcrumb container applies `dragStyle()` so the user can drag the
// window from the chrome on macOS. We therefore stamp `noDragStyle()` on the
// trigger button — without it the click would be swallowed by the drag region.

import { Check, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { ROOMS_MENU_ITEMS, isRoomDisabled } from './rooms-menu-items';

export function RoomsMenuButton() {
  // PERF-3 — granular selectors + stable dispatch. `s.activeWorkspace` is a
  // referentially-stable slice and `s.room` is a primitive, so both honour the
  // useSyncExternalStore Object.is bail-out (no re-render on unrelated dispatch).
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((s) => s.activeWorkspace);
  const room = useAppStateSelector((s) => s.room);
  const hasActiveWorkspace = activeWorkspace !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open rooms menu"
          title="Rooms"
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            room !== 'command'
              ? 'bg-accent/30 text-foreground hover:bg-accent/50 hover:text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          style={noDragStyle()}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-56">
        {ROOMS_MENU_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = room === item.id;
          const disabled = isRoomDisabled(item.id, hasActiveWorkspace);
          return (
            <DropdownMenuItem
              key={item.id}
              disabled={disabled}
              onSelect={(event) => {
                if (disabled) {
                  event.preventDefault();
                  return;
                }
                dispatch({ type: 'SET_ROOM', room: item.id });
              }}
              aria-label={item.label}
              aria-current={isActive ? 'true' : undefined}
              data-room-id={item.id}
              className={cn(
                'flex items-center gap-2',
                isActive && 'bg-primary/15 text-primary',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {isActive ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
