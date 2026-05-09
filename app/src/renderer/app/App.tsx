import { Sidebar } from '@/renderer/features/sidebar/Sidebar';
import { WorkspaceLauncher } from '@/renderer/features/workspace-launcher/Launcher';
import { CommandRoom } from '@/renderer/features/command-room/CommandRoom';
import { PhasePlaceholder } from '@/renderer/features/placeholders/PhasePlaceholder';
import { AppStateProvider, useAppState } from '@/renderer/app/state';

function RoomSwitch() {
  const { state } = useAppState();
  switch (state.room) {
    case 'workspaces':
      return <WorkspaceLauncher />;
    case 'command':
      return <CommandRoom />;
    case 'swarm':
      return (
        <PhasePlaceholder
          title="Swarm Room"
          phase={2}
          description="Roster of role-bearing agents (Coordinator / Builder / Scout / Reviewer) with a file-system mailbox bus, side-chat, and operator broadcast."
          bullets={[
            'Role presets and per-role provider assignment',
            'Coordinator-driven roll-call and task delegation',
            'Operator broadcast tool',
            'Mailbox messages persisted in SQLite',
          ]}
        />
      );
    case 'review':
      return (
        <PhasePlaceholder
          title="Review Room"
          phase={4}
          description="Per-session diff viewer, test runner, and commit + merge with auto-cleanup of merged worktrees."
        />
      );
    case 'memory':
      return (
        <PhasePlaceholder
          title="Memory"
          phase={4}
          description="Local-first wikilink notes with a force-directed graph and an MCP server that exposes 12 shared-memory tools to every agent."
        />
      );
    case 'browser':
      return (
        <PhasePlaceholder
          title="Browser"
          phase={3}
          description="In-app WebContentsView pane plus a managed Playwright MCP server attached over CDP, so agents drive the same tab the user sees."
        />
      );
    case 'skills':
      return (
        <PhasePlaceholder
          title="Skills"
          phase={3}
          description="Drag-and-drop SKILL.md folders. Skills fan out to per-provider locations (.claude / .codex / .gemini)."
        />
      );
    case 'settings':
      return (
        <PhasePlaceholder
          title="Settings"
          phase={1}
          description="Provider definitions, themes, and MCP server configuration. Phase 1 ships with built-in provider list and probe; UI editor lands later."
        />
      );
    default:
      return null;
  }
}

export default function App() {
  return (
    <AppStateProvider>
      <div className="flex h-full w-full">
        <Sidebar />
        <main className="flex min-h-0 flex-1 flex-col">
          <RoomSwitch />
        </main>
      </div>
    </AppStateProvider>
  );
}
