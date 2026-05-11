import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { Sidebar } from '@/renderer/features/sidebar/Sidebar';
import { Breadcrumb } from '@/renderer/features/top-bar/Breadcrumb';
import { VoicePill } from '@/renderer/features/voice/VoicePill';
import { WorkspaceLauncher } from '@/renderer/features/workspace-launcher/Launcher';
import { CommandRoom } from '@/renderer/features/command-room/CommandRoom';
import { SwarmRoom } from '@/renderer/features/swarm-room/SwarmRoom';
import { OperatorConsole } from '@/renderer/features/operator-console';
import { BrowserRoom } from '@/renderer/features/browser/BrowserRoom';
import { SkillsRoom } from '@/renderer/features/skills/SkillsRoom';
import { MemoryRoom } from '@/renderer/features/memory/MemoryRoom';
import { ReviewRoom } from '@/renderer/features/review/ReviewRoom';
import { TasksRoom } from '@/renderer/features/tasks/TasksRoom';
import { SettingsRoom } from '@/renderer/features/settings/SettingsRoom';
import { BridgeRoom } from '@/renderer/features/bridge-agent/BridgeRoom';
import { CommandPalette } from '@/renderer/features/command-palette/CommandPalette';
import { OnboardingModal } from '@/renderer/features/onboarding/OnboardingModal';
import { NativeRebuildModal } from '@/renderer/components/NativeRebuildModal';
import { RightRail } from '@/renderer/features/right-rail/RightRail';
import { RightRailProvider } from '@/renderer/features/right-rail/RightRailContext';
import { useRightRailEnabled } from '@/renderer/features/right-rail/use-right-rail-enabled';
import { ThemeProvider } from '@/renderer/app/ThemeProvider';
import { AppStateProvider, useAppState } from '@/renderer/app/state';

function RoomSwitch() {
  const { state } = useAppState();
  // BUG-W7-014: expose the active room id on `<body>` so end-to-end tests can
  // verify which room actually rendered (rather than relying on screenshot
  // filenames that lie when sidebar gating routes the click elsewhere).
  useEffect(() => {
    document.body.setAttribute('data-room', state.room);
    return () => document.body.removeAttribute('data-room');
  }, [state.room]);
  switch (state.room) {
    case 'workspaces':
      return <WorkspaceLauncher />;
    case 'command':
      return <CommandRoom />;
    case 'swarm':
      return <SwarmRoom />;
    case 'operator':
      return <OperatorConsole />;
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
    case 'bridge':
      return <BridgeRoom variant="standalone" />;
    case 'settings':
      return <SettingsRoom />;
    default:
      return null;
  }
}

/**
 * Body wrapper that conditionally hosts the right-rail dock. When the
 * `rightRail.enabled` kv flag is on (the default) the room contents render in
 * the left column and the dock occupies the right column; when disabled we
 * fall back to the legacy single-column layout. The kv read is async, so until
 * it resolves we render the body alone — preventing a rail-flash on cold boot.
 *
 * Special-case: while the user is in the dedicated `browser` room, we hide
 * the rail entirely. The Browser surface is the rail's own first tab, so
 * mounting it twice would fight over the WebContentsView bounds.
 */
function MainBody() {
  const { state } = useAppState();
  const { enabled, ready } = useRightRailEnabled();
  // Hide the rail when the user is in a room whose body already lives in the
  // rail (Browser tab → 'browser', Bridge tab → 'bridge') so we don't double-
  // mount the WebContentsView (browser) or the chat surface (bridge).
  const showRail =
    ready && enabled && state.room !== 'browser' && state.room !== 'bridge';
  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <RoomSwitch />
    </div>
  );
  if (!showRail) return body;
  return <RightRail>{body}</RightRail>;
}

export default function App() {
  return (
    <AppStateProvider>
      <ThemeProvider>
        {/* v1.1.4 Step 3 — the right-rail's active-tab state lives in
            `RightRailContext` so both the top-bar `RightRailSwitcher`
            (inside Breadcrumb) and the rail itself (`RightRail`) share
            one source of truth. The provider wraps both. */}
        <RightRailProvider>
          <div className="flex h-full w-full">
            <Sidebar />
            <main className="flex min-h-0 flex-1 flex-col">
              {/* V3-W15-001 — title-bar BridgeVoice pill overlays the breadcrumb
                  while a voice session is active. The pill auto-hides 200ms
                  after capture stops so we don't reserve layout space. */}
              <div className="relative">
                <Breadcrumb />
                <div className="pointer-events-none absolute inset-x-0 top-0 flex h-8 items-center justify-center">
                  <VoicePill />
                </div>
              </div>
              <MainBody />
            </main>
          </div>
        </RightRailProvider>
        <CommandPalette />
        <OnboardingModal />
        <NativeRebuildModal />
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          theme="dark"
        />
      </ThemeProvider>
    </AppStateProvider>
  );
}
