// Global command palette (cmd/ctrl+k). Aggregates the same actions the
// sidebar exposes, plus a set of imperative quick actions (kill all PTYs,
// switch theme, ingest a skill folder, etc.). All sources are filtered
// against the current workspace + onboarded state so disabled commands stay
// hidden rather than failing silently when invoked.

import { useCallback, useEffect, useMemo } from 'react';
import {
  Command as CommandIcon,
  Folder,
  GitBranch,
  Globe,
  ListChecks,
  Network,
  Palette,
  Power,
  Settings as SettingsIcon,
  Skull,
  Sparkles,
  Terminal,
  Wand2,
  StickyNote,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState, type RoomId } from '@/renderer/app/state';
import { useTheme } from '@/renderer/app/ThemeProvider';
import { THEMES, type ThemeId } from '@/renderer/lib/themes';
import { bindShortcut } from '@/renderer/lib/shortcuts';
import type { Workspace } from '@/shared/types';

interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
  disabled?: boolean;
}

const ROOM_DEFS: Array<{ id: RoomId; label: string; icon: PaletteCommand['icon'] }> = [
  { id: 'workspaces', label: 'Workspaces', icon: Folder },
  { id: 'command', label: 'Command Room', icon: Terminal },
  { id: 'swarm', label: 'Swarm Room', icon: Network },
  { id: 'review', label: 'Review Room', icon: GitBranch },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'memory', label: 'Memory', icon: Sparkles },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'skills', label: 'Skills', icon: Wand2 },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function CommandPalette() {
  const { state, dispatch } = useAppState();
  const { theme, setTheme } = useTheme();
  const open = state.commandPaletteOpen;
  const setOpen = useCallback(
    (o: boolean) => dispatch({ type: 'SET_COMMAND_PALETTE', open: o }),
    [dispatch],
  );

  // Bind mod+k to toggle.
  useEffect(() => {
    const off = bindShortcut('mod+k', (e) => {
      e.preventDefault();
      dispatch({ type: 'SET_COMMAND_PALETTE', open: !state.commandPaletteOpen });
    });
    return off;
  }, [dispatch, state.commandPaletteOpen]);

  const items = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];
    const ws = state.activeWorkspace;
    const wsId = ws?.id;

    // Navigate
    for (const room of ROOM_DEFS) {
      const requiresWs =
        room.id !== 'workspaces' && room.id !== 'settings' && room.id !== 'skills';
      list.push({
        id: `nav:${room.id}`,
        label: `Go to ${room.label}`,
        group: 'Navigate',
        icon: room.icon,
        disabled: requiresWs && !ws,
        run: () => {
          dispatch({ type: 'SET_ROOM', room: room.id });
          setOpen(false);
        },
      });
    }

    // Recent workspaces
    for (const w of state.workspaces.slice(0, 8)) {
      list.push({
        id: `ws:${w.id}`,
        label: `Open: ${w.name}`,
        hint: w.rootPath,
        group: 'Recent workspaces',
        icon: Folder,
        run: () => {
          void (async () => {
            try {
              const reopened = await rpc.workspaces.open((w as Workspace).rootPath);
              dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: reopened });
            } catch (err) {
              console.error('open workspace failed', err);
            } finally {
              setOpen(false);
            }
          })();
        },
      });
    }

    // Themes
    for (const t of THEMES) {
      list.push({
        id: `theme:${t.id}`,
        label: `Switch theme: ${t.label}`,
        hint: theme === t.id ? 'current' : t.description,
        group: 'Theme',
        icon: Palette,
        run: () => {
          setTheme(t.id as ThemeId);
          setOpen(false);
        },
      });
    }

    // Imperative actions
    list.push({
      id: 'ptys:kill',
      label: 'Kill all PTYs in active workspace',
      group: 'Actions',
      icon: Skull,
      disabled: !ws || state.sessions.filter((s) => s.workspaceId === wsId).length === 0,
      run: () => {
        if (!wsId) return;
        const targets = state.sessions.filter((s) => s.workspaceId === wsId);
        for (const s of targets) {
          void rpc.pty.kill(s.id).catch(() => undefined);
        }
        setOpen(false);
      },
    });

    list.push({
      id: 'swarm:kill',
      label: 'Kill active swarm',
      group: 'Actions',
      icon: Power,
      disabled: !state.activeSwarmId,
      run: () => {
        if (!state.activeSwarmId) return;
        const id = state.activeSwarmId;
        void rpc.swarms.kill(id).then(() => {
          dispatch({ type: 'MARK_SWARM_ENDED', id });
        });
        setOpen(false);
      },
    });

    list.push({
      id: 'memory:new',
      label: 'New memory note in active workspace',
      group: 'Actions',
      icon: StickyNote,
      disabled: !wsId,
      run: () => {
        if (!wsId) return;
        const name = window.prompt('Note name:');
        if (!name) {
          setOpen(false);
          return;
        }
        void rpc.memory
          .create_memory({ workspaceId: wsId, name })
          .then((memory) => {
            dispatch({ type: 'UPSERT_MEMORY', workspaceId: wsId, memory });
            dispatch({ type: 'SET_ACTIVE_MEMORY', workspaceId: wsId, name: memory.name });
            dispatch({ type: 'SET_ROOM', room: 'memory' });
          })
          .catch((err) => console.error('create memory failed', err));
        setOpen(false);
      },
    });

    list.push({
      id: 'skill:ingest',
      label: 'Ingest a skill folder…',
      group: 'Actions',
      icon: Wand2,
      run: () => {
        void (async () => {
          try {
            const r = await rpc.workspaces.pickFolder();
            if (!r) return;
            await rpc.skills.ingestFolder({ path: r.path });
            dispatch({ type: 'SET_ROOM', room: 'skills' });
          } catch (err) {
            console.error('ingest skill failed', err);
          } finally {
            setOpen(false);
          }
        })();
      },
    });

    list.push({
      id: 'review:run-tests',
      label: 'Run command in active worktree…',
      group: 'Actions',
      icon: GitBranch,
      disabled: !state.activeReviewSessionId,
      run: () => {
        if (!state.activeReviewSessionId) return;
        const cmd = window.prompt('Command to run:');
        if (!cmd) {
          setOpen(false);
          return;
        }
        void rpc.review
          .runCommand({ sessionId: state.activeReviewSessionId, command: cmd })
          .catch((err) => console.error('runCommand failed', err));
        setOpen(false);
      },
    });

    return list;
  }, [
    state.workspaces,
    state.activeWorkspace,
    state.sessions,
    state.activeSwarmId,
    state.activeReviewSessionId,
    theme,
    dispatch,
    setTheme,
    setOpen,
  ]);

  // Group items by `group` while preserving insertion order.
  const grouped = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, PaletteCommand[]>();
    for (const it of items) {
      if (!map.has(it.group)) {
        map.set(it.group, []);
        order.push(it.group);
      }
      map.get(it.group)!.push(it);
    }
    return order.map((g) => ({ group: g, items: map.get(g)! }));
  }, [items]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search rooms, workspaces, themes, and quick actions."
    >
      <CommandInput placeholder="Type a command, room, or theme…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {grouped.map((g, idx) => (
          <div key={g.group}>
            {idx > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={g.group}>
              {g.items.map((it) => {
                const Icon = it.icon;
                return (
                  <CommandItem
                    key={it.id}
                    value={`${it.group} ${it.label} ${it.hint ?? ''}`}
                    disabled={it.disabled}
                    onSelect={() => {
                      if (it.disabled) return;
                      it.run();
                    }}
                  >
                    <Icon className="mr-2 h-4 w-4" />
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint ? (
                      <span className="ml-2 truncate text-xs text-muted-foreground">{it.hint}</span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
      <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <CommandIcon className="h-3 w-3" /> SigmaLink command palette
        </span>
        <span>Esc to close · Enter to run</span>
      </div>
    </CommandDialog>
  );
}
