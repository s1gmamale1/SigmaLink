import { Suspense, lazy, useEffect, type ReactElement } from 'react';
import { Toaster } from 'sonner';
import { Sidebar } from '@/renderer/features/sidebar/Sidebar';
import { Breadcrumb } from '@/renderer/features/top-bar/Breadcrumb';
import { VoicePill } from '@/renderer/features/voice/VoicePill';
// CommandRoom stays eager — it's the default landing room, so lazy-loading
// it would add a Suspense flash on cold boot. Every other room is code-split
// via React.lazy below so the main bundle ships ~30 KB gzip lighter
// (rooms are only fetched when the user navigates to them).
import { CommandRoom } from '@/renderer/features/command-room/CommandRoom';
import { CommandPalette } from '@/renderer/features/command-palette/CommandPalette';
import { OnboardingModal } from '@/renderer/features/onboarding/OnboardingModal';
import { NativeRebuildModal } from '@/renderer/components/NativeRebuildModal';
import { RightRail } from '@/renderer/features/right-rail/RightRail';
import { RightRailProvider } from '@/renderer/features/right-rail/RightRailContext';
import { useRightRailEnabled } from '@/renderer/features/right-rail/use-right-rail-enabled';
import { ThemeProvider } from '@/renderer/app/ThemeProvider';
import { AppStateProvider, useAppState } from '@/renderer/app/state';

// --- Lazy rooms ----------------------------------------------------------
// Each room is wrapped in `React.lazy` so its module (and the heavy feature
// subtrees it pulls in — operator-console, bridge-agent, memory, skills,
// browser, etc.) stays out of the main chunk until the user actually
// navigates there. Named exports are adapted to default exports via the
// `then(m => ({ default: m.X }))` shim — see `EditorTab.tsx` for the
// existing reference pattern (Monaco loader).
const WorkspaceLauncher = lazy(() =>
  import('@/renderer/features/workspace-launcher/Launcher').then((m) => ({
    default: m.WorkspaceLauncher,
  })),
);
const SwarmRoom = lazy(() =>
  import('@/renderer/features/swarm-room/SwarmRoom').then((m) => ({
    default: m.SwarmRoom,
  })),
);
const OperatorConsole = lazy(() =>
  import('@/renderer/features/operator-console').then((m) => ({
    default: m.OperatorConsole,
  })),
);
const BrowserRoom = lazy(() =>
  import('@/renderer/features/browser/BrowserRoom').then((m) => ({
    default: m.BrowserRoom,
  })),
);
const SkillsRoom = lazy(() =>
  import('@/renderer/features/skills/SkillsRoom').then((m) => ({
    default: m.SkillsRoom,
  })),
);
const MemoryRoom = lazy(() =>
  import('@/renderer/features/memory/MemoryRoom').then((m) => ({
    default: m.MemoryRoom,
  })),
);
const ReviewRoom = lazy(() =>
  import('@/renderer/features/review/ReviewRoom').then((m) => ({
    default: m.ReviewRoom,
  })),
);
const TasksRoom = lazy(() =>
  import('@/renderer/features/tasks/TasksRoom').then((m) => ({
    default: m.TasksRoom,
  })),
);
const SettingsRoom = lazy(() =>
  import('@/renderer/features/settings/SettingsRoom').then((m) => ({
    default: m.SettingsRoom,
  })),
);
const SigmaRoom = lazy(() =>
  import('@/renderer/features/sigma-assistant/SigmaRoom').then((m) => ({
    default: m.SigmaRoom,
  })),
);

// Lightweight placeholder rendered while a lazy room module is downloading.
// Kept inline (no separate file) so it adds zero bytes to the main chunk
// beyond the markup itself.
function RoomSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading room"
      className="flex min-h-0 flex-1 animate-pulse bg-muted/30"
    />
  );
}

function RoomSwitch() {
  const { state } = useAppState();
  // BUG-W7-014: expose the active room id on `<body>` so end-to-end tests can
  // verify which room actually rendered (rather than relying on screenshot
  // filenames that lie when sidebar gating routes the click elsewhere).
  useEffect(() => {
    document.body.setAttribute('data-room', state.room);
    return () => document.body.removeAttribute('data-room');
  }, [state.room]);
  // CommandRoom stays eager (default landing room → no Suspense flash on
  // cold boot). Every other room is lazy-mounted, so wrap them in a single
  // Suspense boundary keyed by room id — that way re-entering the same room
  // doesn't re-trigger the fallback once the chunk is cached.
  let body: ReactElement | null;
  switch (state.room) {
    case 'command':
      return <CommandRoom />;
    case 'workspaces':
      body = <WorkspaceLauncher />;
      break;
    case 'swarm':
      body = <SwarmRoom />;
      break;
    case 'operator':
      body = <OperatorConsole />;
      break;
    case 'review':
      body = <ReviewRoom />;
      break;
    case 'tasks':
      body = <TasksRoom />;
      break;
    case 'memory':
      body = <MemoryRoom />;
      break;
    case 'browser':
      body = <BrowserRoom />;
      break;
    case 'skills':
      body = <SkillsRoom />;
      break;
    case 'sigma':
      body = <SigmaRoom variant="standalone" />;
      break;
    case 'settings':
      body = <SettingsRoom />;
      break;
    default:
      return null;
  }
  return <Suspense fallback={<RoomSkeleton />}>{body}</Suspense>;
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
  // rail (Browser tab → 'browser', Sigma tab → 'sigma') so we don't double-
  // mount the WebContentsView (browser) or the chat surface (sigma).
  const showRail =
    ready && enabled && state.room !== 'browser' && state.room !== 'sigma';
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
              {/* V3-W15-001 — title-bar SigmaVoice pill overlays the breadcrumb
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
