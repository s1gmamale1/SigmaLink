// Pure data + logic for the v1.1.4 rooms menu. Split out of
// `RoomsMenuButton.tsx` so the component file exports only a component —
// keeps `react-refresh/only-export-components` happy.

import {
  Bot,
  Folder,
  GitBranch,
  Globe,
  LayoutGrid,
  Network,
  Settings,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';
import type { RoomId } from '@/renderer/app/state';

export interface RoomMenuItem {
  id: RoomId;
  label: string;
  icon: typeof Folder;
}

// Lifted from `Sidebar.tsx` (ITEMS, lines 53-73). Keep this list in lockstep
// with the sidebar so the two surfaces never drift in label or order.
export const ROOMS_MENU_ITEMS: readonly RoomMenuItem[] = [
  { id: 'workspaces', label: 'Workspaces', icon: Folder },
  { id: 'command', label: 'Command Room', icon: Terminal },
  { id: 'swarm', label: 'Swarm Room', icon: Network },
  { id: 'operator', label: 'Operator Console', icon: Network },
  { id: 'review', label: 'Review Room', icon: GitBranch },
  { id: 'tasks', label: 'Tasks', icon: LayoutGrid },
  { id: 'memory', label: 'Memory', icon: Sparkles },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'skills', label: 'Skills', icon: Wand2 },
  { id: 'bridge', label: 'Sigma Assistant', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings },
];

// Mirror of Sidebar.tsx line ~186: Workspaces / Settings / Skills / Bridge
// stay reachable so the user can recover from a "no workspace" state; the
// rest require an active workspace.
export function isRoomDisabled(roomId: RoomId, hasActiveWorkspace: boolean): boolean {
  if (hasActiveWorkspace) return false;
  return (
    roomId !== 'workspaces' &&
    roomId !== 'settings' &&
    roomId !== 'skills' &&
    roomId !== 'bridge'
  );
}
