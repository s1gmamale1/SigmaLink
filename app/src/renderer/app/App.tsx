import { Sidebar } from '@/renderer/features/sidebar/Sidebar';
import { WorkspaceLauncher } from '@/renderer/features/workspace-launcher/Launcher';
import { CommandRoom } from '@/renderer/features/command-room/CommandRoom';
import { SwarmRoom } from '@/renderer/features/swarm-room/SwarmRoom';
import { BrowserRoom } from '@/renderer/features/browser/BrowserRoom';
import { SkillsRoom } from '@/renderer/features/skills/SkillsRoom';
import { MemoryRoom } from '@/renderer/features/memory/MemoryRoom';
import { ReviewRoom } from '@/renderer/features/review/ReviewRoom';
import { TasksRoom } from '@/renderer/features/tasks/TasksRoom';
import { SettingsRoom } from '@/renderer/features/settings/SettingsRoom';
import { CommandPalette } from '@/renderer/features/command-palette/CommandPalette';
import { OnboardingModal } from '@/renderer/features/onboarding/OnboardingModal';
import { ThemeProvider } from '@/renderer/app/ThemeProvider';
import { AppStateProvider, useAppState } from '@/renderer/app/state';

function RoomSwitch() {
  const { state } = useAppState();
  switch (state.room) {
    case 'workspaces':
      return <WorkspaceLauncher />;
    case 'command':
      return <CommandRoom />;
    case 'swarm':
      return <SwarmRoom />;
    case 'review':
      return <ReviewRoom />;
    case 'tasks':
      return <TasksRoom />;
    case 'memory':
      return <MemoryRoom />;
    case 'browser':
      return <BrowserRoom />;
    case 'skills':
      return <SkillsRoom />;
    case 'settings':
      return <SettingsRoom />;
    default:
      return null;
  }
}

export default function App() {
  return (
    <AppStateProvider>
      <ThemeProvider>
        <div className="flex h-full w-full">
          <Sidebar />
          <main className="flex min-h-0 flex-1 flex-col">
            <RoomSwitch />
          </main>
        </div>
        <CommandPalette />
        <OnboardingModal />
      </ThemeProvider>
    </AppStateProvider>
  );
}
