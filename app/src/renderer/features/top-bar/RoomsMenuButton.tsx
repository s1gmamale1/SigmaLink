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
import { useAppState } from '@/renderer/app/state';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { ROOMS_MENU_ITEMS, isRoomDisabled } from './rooms-menu-items';

export function RoomsMenuButton() {
  const { state, dispatch } = useAppState();
  const hasActiveWorkspace = state.activeWorkspace !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open rooms menu"
          title="Rooms"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={noDragStyle()}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-56">
        {ROOMS_MENU_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = state.room === item.id;
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
              data-room-id={item.id}
              className={cn(
                'flex items-center gap-2',
                isActive && 'bg-accent/40 text-accent-foreground',
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
